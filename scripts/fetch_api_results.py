"""
fetch_api_results.py
====================

Fully-automated results ingestion: pull FINISHED matches from
football-data.org, map team codes to results.csv names, de-duplicate
against the existing file, append the new rows, then rebuild
team_momentum.json (momentum + Elo join + xG + ML model).

This moves data-fetching OFF the Next.js app (Vercel's filesystem is
read-only in prod) and into a backend script you can cron.

Secrets:
    Put your key in a .env file next to this script:
        FOOTBALL_DATA_API_KEY=your_key_here
    (.env should be git-ignored. Rotate the key if it ever leaks.)

Usage:
    pip install requests
    python fetch_api_results.py                 # fetch → append → recompute
    python fetch_api_results.py --dry-run       # show what WOULD be added
    python fetch_api_results.py --no-recompute  # append only
"""

from __future__ import annotations

import argparse
import csv
import os
import subprocess
import sys
from datetime import date as date_cls
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing dependency — run:  pip install requests")

SCRIPT_DIR = Path(__file__).resolve().parent
BASE_URL = "https://api.football-data.org/v4"
DEFAULT_COMPETITION = "WC"          # FIFA World Cup
DEFAULT_TOURNAMENT = "FIFA World Cup"

# Full schema compute_momentum.py consumes (used when creating a fresh file).
STANDARD_COLUMNS = [
    "date", "home_team", "away_team", "home_score", "away_score",
    "tournament", "city", "country", "neutral",
]

# football-data.org 3-letter code (tla) → exact results.csv team name.
# The API also returns a full `name`, used as fallback for any code not here.
TEAM_CODE_MAP = {
    "JPN": "Japan", "ESP": "Spain", "BRA": "Brazil", "ARG": "Argentina",
    "FRA": "France", "GER": "Germany", "ENG": "England", "ITA": "Italy",
    "POR": "Portugal", "NED": "Netherlands", "BEL": "Belgium", "CRO": "Croatia",
    "COL": "Colombia", "URU": "Uruguay", "USA": "United States", "MEX": "Mexico",
    "SUI": "Switzerland", "SEN": "Senegal", "DEN": "Denmark", "IRN": "Iran",
    "KOR": "South Korea", "PRK": "North Korea", "AUS": "Australia",
    "ECU": "Ecuador", "UKR": "Ukraine", "AUT": "Austria", "SWE": "Sweden",
    "TUR": "Turkey", "WAL": "Wales", "SRB": "Serbia", "POL": "Poland",
    "EGY": "Egypt", "NGA": "Nigeria", "PER": "Peru", "ALG": "Algeria",
    "SCO": "Scotland", "CAN": "Canada", "CHI": "Chile", "TUN": "Tunisia",
    "CMR": "Cameroon", "KSA": "Saudi Arabia", "GHA": "Ghana", "QAT": "Qatar",
    "CIV": "Ivory Coast", "NOR": "Norway", "MAR": "Morocco", "CRC": "Costa Rica",
    "PAR": "Paraguay", "VEN": "Venezuela", "BOL": "Bolivia", "JAM": "Jamaica",
    "PAN": "Panama", "HON": "Honduras", "RSA": "South Africa", "MLI": "Mali",
    "NZL": "New Zealand", "UZB": "Uzbekistan", "IRQ": "Iraq",
    "UAE": "United Arab Emirates", "JOR": "Jordan", "OMA": "Oman",
    "CHN": "China PR", "IND": "India", "GRE": "Greece", "CZE": "Czech Republic",
    "ROU": "Romania", "HUN": "Hungary", "SVN": "Slovenia", "SVK": "Slovakia",
    "RUS": "Russia", "BIH": "Bosnia and Herzegovina", "NIR": "Northern Ireland",
    "IRL": "Republic of Ireland", "ISL": "Iceland", "FIN": "Finland",
    "CPV": "Cape Verde", "COD": "DR Congo",'HAI': 'Haiti',
    'CUW': 'Curacao', 
    'URY': 'Uruguay',
}


# ── Environment ──────────────────────────────────────────────────────
def load_dotenv(path: Path) -> None:
    """Minimal .env loader (no extra dependency). Does not override vars
    already set in the real environment."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def get_api_key() -> str:
    load_dotenv(SCRIPT_DIR / ".env")
    load_dotenv(Path.cwd() / ".env")
    key = os.environ.get("FOOTBALL_DATA_API_KEY")
    if not key:
        sys.exit("FOOTBALL_DATA_API_KEY not found — add it to scripts/.env")
    return key


# ── Fetch ────────────────────────────────────────────────────────────
def fetch_finished_matches(api_key: str, competition: str) -> list[dict]:
    url = f"{BASE_URL}/competitions/{competition}/matches?status=FINISHED"
    try:
        resp = requests.get(url, headers={"X-Auth-Token": api_key}, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as err:
        raise SystemExit(f"[api] request failed ({err}). results.csv left untouched.")
    return resp.json().get("matches", [])


# ── Mapping & parsing ────────────────────────────────────────────────
def team_name(tla: str | None, fallback: str | None) -> str:
    code = (tla or "").upper()
    if code in TEAM_CODE_MAP:
        return TEAM_CODE_MAP[code]
    if fallback:
        print(f"[map] no code mapping for '{tla}' — using API name '{fallback}'.")
        return fallback
    return code


def norm(s: object) -> str:
    return str(s or "").strip().lower()


def match_record(m: dict) -> dict | None:
    """Convert one API match into a flat record, or None if not usable."""
    if m.get("status") not in ("FINISHED", "AWARDED"):
        return None
    ft = (m.get("score") or {}).get("fullTime") or {}
    if ft.get("home") is None or ft.get("away") is None:
        return None

    home, away = m.get("homeTeam", {}), m.get("awayTeam", {})
    hs, as_ = int(ft["home"]), int(ft["away"])
    rec = {
        "date": (m.get("utcDate") or "")[:10],
        "home_team": team_name(home.get("tla"), home.get("name") or home.get("shortName")),
        "away_team": team_name(away.get("tla"), away.get("name") or away.get("shortName")),
        "home_score": hs,
        "away_score": as_,
        "home_goals": hs,  # alias for short-schema files
        "away_goals": as_,
        "tournament": DEFAULT_TOURNAMENT,
        "city": "",
        "country": "",
        "neutral": "TRUE",
    }
    return rec


# ── CSV de-dup + append ──────────────────────────────────────────────
def read_existing(path: Path) -> tuple[list[str], set[tuple]]:
    """Return (header, set of dedup keys) for the existing results.csv."""
    if not path.exists() or path.stat().st_size == 0:
        return STANDARD_COLUMNS, set()
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or STANDARD_COLUMNS
        keys = {dedup_key(row, fieldnames) for row in reader}
    return fieldnames, keys


def row_score(row: dict, side: str) -> str:
    for col in (f"{side}_score", f"{side}_goals"):
        if str(row.get(col, "")).strip() != "":
            return str(row[col]).strip()
    return ""


def dedup_key(row: dict, fieldnames: list[str]) -> tuple:
    # Prefer (date, home, away) when a date column exists; else fall back
    # to (home, away, scores) so we still avoid obvious duplicates.
    if "date" in fieldnames:
        return (norm(row.get("date")), norm(row.get("home_team")), norm(row.get("away_team")))
    return (norm(row.get("home_team")), norm(row.get("away_team")),
            row_score(row, "home"), row_score(row, "away"))


def append_rows(path: Path, fieldnames: list[str], records: list[dict]) -> None:
    new_file = not path.exists() or path.stat().st_size == 0
    with path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if new_file:
            writer.writeheader()
        for rec in records:
            writer.writerow({col: rec.get(col, "") for col in fieldnames})


# ── Orchestration ────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Fetch finished matches → results.csv → recompute.")
    p.add_argument("--results", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--competition", default=DEFAULT_COMPETITION)
    p.add_argument("--output", default="../public/team_momentum.json",
                   help="Forwarded to compute_momentum.py --output.")
    p.add_argument("--dry-run", action="store_true", help="Show new matches, write nothing.")
    p.add_argument("--no-recompute", action="store_true", help="Append but skip recompute.")
    args = p.parse_args()

    api_key = get_api_key()
    matches = fetch_finished_matches(api_key, args.competition)
    print(f"[api] {len(matches)} finished matches returned for {args.competition}.")

    fieldnames, existing = read_existing(args.results)

    new_records: list[dict] = []
    seen_this_run: set[tuple] = set()
    for m in matches:
        rec = match_record(m)
        if rec is None:
            continue
        key = dedup_key(rec, fieldnames)
        if key in existing or key in seen_this_run:
            continue
        seen_this_run.add(key)
        new_records.append(rec)

    if not new_records:
        print("[csv] No new finished matches — already up to date.")
        return

    print(f"[csv] {len(new_records)} new match(es):")
    for r in new_records:
        print(f"      {r['date']}  {r['home_team']} {r['home_score']}–{r['away_score']} {r['away_team']}")

    if args.dry_run:
        print("[dry-run] Nothing written.")
        return

    append_rows(args.results, fieldnames, new_records)
    print(f"[csv] Appended → {args.results}")

    if args.no_recompute:
        print("Skipped recompute (--no-recompute).")
        return

    cmd = [sys.executable, str(SCRIPT_DIR / "compute_momentum.py"), "--output", args.output]
    print(f"→ {' '.join(cmd)}\n")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(f"\ncompute_momentum.py failed (exit {result.returncode}).")
    print("\n✓ team_momentum.json refreshed.")


if __name__ == "__main__":
    main()
