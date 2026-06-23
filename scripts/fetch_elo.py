"""
fetch_elo.py
============

Scrape the current World Football Elo ratings from eloratings.net's backend
data file and write them to elo_ratings.csv in the format
compute_momentum.py expects:  country, rating, snapshot_date.

eloratings.net renders client-side from tab-separated (.tsv) data files.
The current global table is served as a .tsv. Because that URL / column
layout is third-party and can change, this script:
  • auto-detects the team-name and rating columns,
  • prints a preview so you can sanity-check,
  • REFUSES to overwrite your existing CSV if the parse looks wrong
    (fewer than --min-teams rows), so a bad fetch never clobbers good data.

If the site layout shifts, inspect it in your browser (DevTools → Network →
filter ".tsv") and override with --url / --name-col / --rating-col.

Usage:
    pip install requests
    python fetch_elo.py                 # fetch → verify → write elo_ratings.csv
    python fetch_elo.py --dry-run       # fetch + preview only, write nothing
    python fetch_elo.py --url https://www.eloratings.net/World.tsv \
                        --name-col 2 --rating-col 3
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Missing dependency — run:  pip install requests")

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_URL = "https://www.eloratings.net/World.tsv"
DEFAULT_OUTPUT = SCRIPT_DIR / "elo_ratings.csv"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# eloratings.net name  →  the name used in results.csv (FIFA-style).
# The join in compute_momentum.py normalises case/accents, so only add
# entries here where the two sources genuinely DIFFER. Extend as needed.
NAME_MAP = {
    "USA": "United States",
    "Korea Republic": "South Korea",
    "Korea DPR": "North Korea",
    "IR Iran": "Iran",
    "China PR": "China",
    "Czechia": "Czech Republic",
    "Türkiye": "Turkey",
    "Turkiye": "Turkey",
    "Cabo Verde": "Cape Verde",
    "Côte d'Ivoire": "Ivory Coast",
    "Bosnia": "Bosnia and Herzegovina",
    "DR Congo": "DR Congo",
    "Congo DR": "DR Congo",
    "Ireland": "Republic of Ireland",
}

# eloratings.net 2-letter code  →  full team name (results.csv style).
# World.tsv ships CODES, not names, so we resolve them here. Mostly ISO
# alpha-2; UK home nations + Kosovo/Curaçao use eloratings' custom codes.
ELO_CODE_MAP = {
    # UEFA
    "AL": "Albania", "AD": "Andorra", "AM": "Armenia", "AT": "Austria",
    "AZ": "Azerbaijan", "BY": "Belarus", "BE": "Belgium",
    "BA": "Bosnia and Herzegovina", "BG": "Bulgaria", "HR": "Croatia",
    "CY": "Cyprus", "CZ": "Czech Republic", "DK": "Denmark", "EN": "England",
    "EE": "Estonia", "FO": "Faroe Islands", "FI": "Finland", "FR": "France",
    "GE": "Georgia", "DE": "Germany", "GR": "Greece", "HU": "Hungary",
    "IS": "Iceland", "IE": "Republic of Ireland", "IT": "Italy",
    "XK": "Kosovo", "LV": "Latvia", "LI": "Liechtenstein", "LT": "Lithuania",
    "LU": "Luxembourg", "MT": "Malta", "MD": "Moldova", "ME": "Montenegro",
    "NL": "Netherlands", "MK": "North Macedonia", "NI": "Northern Ireland",
    "NO": "Norway", "PL": "Poland", "PT": "Portugal", "RO": "Romania",
    "RU": "Russia", "SM": "San Marino", "SC": "Scotland", "RS": "Serbia",
    "SK": "Slovakia", "SI": "Slovenia", "ES": "Spain", "SE": "Sweden",
    "CH": "Switzerland", "TR": "Turkey", "UA": "Ukraine", "WL": "Wales",
    # CONMEBOL
    "AR": "Argentina", "BO": "Bolivia", "BR": "Brazil", "CL": "Chile",
    "CO": "Colombia", "EC": "Ecuador", "PY": "Paraguay", "PE": "Peru",
    "UY": "Uruguay", "VE": "Venezuela",
    # CONCACAF
    "CA": "Canada", "CR": "Costa Rica", "CU": "Cuba", "CW": "Curacao",
    "SV": "El Salvador", "GT": "Guatemala", "HT": "Haiti", "HN": "Honduras",
    "JM": "Jamaica", "MX": "Mexico", "PA": "Panama",
    "TT": "Trinidad and Tobago", "US": "United States",
    # CAF
    "DZ": "Algeria", "AO": "Angola", "BJ": "Benin", "BF": "Burkina Faso",
    "CM": "Cameroon", "CV": "Cape Verde", "CG": "Congo", "CD": "DR Congo",
    "CI": "Ivory Coast", "EG": "Egypt", "GQ": "Equatorial Guinea",
    "GA": "Gabon", "GM": "Gambia", "GH": "Ghana", "GN": "Guinea",
    "KE": "Kenya", "MG": "Madagascar", "ML": "Mali", "MR": "Mauritania",
    "MA": "Morocco", "MZ": "Mozambique", "NA": "Namibia", "NG": "Nigeria",
    "SN": "Senegal", "ZA": "South Africa", "SD": "Sudan", "TG": "Togo",
    "TN": "Tunisia", "UG": "Uganda", "ZM": "Zambia", "ZW": "Zimbabwe",
    # AFC
    "AU": "Australia", "BH": "Bahrain", "CN": "China PR", "IN": "India",
    "ID": "Indonesia", "IR": "Iran", "IQ": "Iraq", "JP": "Japan",
    "JO": "Jordan", "KW": "Kuwait", "KG": "Kyrgyzstan", "LB": "Lebanon",
    "MY": "Malaysia", "KP": "North Korea", "OM": "Oman", "PS": "Palestine",
    "QA": "Qatar", "SA": "Saudi Arabia", "KR": "South Korea", "SY": "Syria",
    "TJ": "Tajikistan", "TH": "Thailand", "TM": "Turkmenistan",
    "AE": "United Arab Emirates", "UZ": "Uzbekistan", "VN": "Vietnam",
    # OFC
    "NZ": "New Zealand",
}

OUTPUT_COLUMNS = ["country", "rating", "snapshot_date"]


# ── Fetch ────────────────────────────────────────────────────────────
def fetch_tsv(url: str, retries: int = 3, timeout: int = 15) -> str:
    """GET the raw TSV text, with retries. Raises on total failure so the
    caller can leave the existing CSV untouched."""
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            resp.raise_for_status()
            return resp.content.decode("utf-8", errors="replace")
        except requests.RequestException as err:
            last_err = err
            print(f"[fetch] attempt {attempt}/{retries} failed: {err}", file=sys.stderr)
    raise SystemExit(
        f"[fetch] giving up after {retries} attempts ({last_err}). "
        "Existing elo_ratings.csv left untouched."
    )


# ── Parse ────────────────────────────────────────────────────────────
def _rating_candidates(fields: list[str]) -> list[int]:
    """Integers in a plausible Elo range, excluding year-like values so a
    'year' column can't be mistaken for the rating."""
    out: list[int] = []
    for f in fields:
        f = f.strip()
        try:
            v = int(f)
        except ValueError:
            continue
        if 900 <= v <= 2250 and not (2024 <= v <= 2030):
            out.append(v)
    return out


def parse_ratings(
    text: str, name_col: int | None = None, rating_col: int | None = None
) -> list[tuple[str, int]]:
    """Extract (team_name, rating) pairs from tab-separated rows.

    If name_col/rating_col are given they're used directly; otherwise the
    rating is the first plausible Elo value in the row and the name is the
    longest alphabetic field (so 'Brazil' wins over a 'BRA' code)."""
    rows: list[tuple[str, int]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) < 2:
            continue

        name: str | None = None
        rating: int | None = None

        if name_col is not None and rating_col is not None:
            if max(name_col, rating_col) < len(fields):
                name = fields[name_col].strip()
                try:
                    rating = int(fields[rating_col].strip())
                except ValueError:
                    rating = None
        else:
            cands = _rating_candidates(fields)
            rating = cands[0] if cands else None
            alpha = [f.strip() for f in fields if any(c.isalpha() for c in f)]
            name = max(alpha, key=len) if alpha else None

        if name and rating is not None:
            rows.append((name, rating))
    return rows


def map_name(token: str) -> str:
    """Resolve an eloratings token to a results.csv team name.

    World.tsv gives 2-letter codes (AR, ES…), so codes are resolved first;
    full-name inputs (future-proofing) fall through to NAME_MAP / passthrough.
    """
    token = token.strip()
    if len(token) <= 3 and token.upper() in ELO_CODE_MAP:
        return ELO_CODE_MAP[token.upper()]
    return NAME_MAP.get(token, token)


# ── Write ────────────────────────────────────────────────────────────
def write_csv(rows: list[tuple[str, int]], path: Path, snapshot: str, append: bool) -> None:
    # Dedupe within this snapshot, keeping the first (highest list position).
    seen: set[str] = set()
    mode = "a" if append and path.exists() and path.stat().st_size > 0 else "w"
    with path.open(mode, encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        if mode == "w":
            writer.writerow(OUTPUT_COLUMNS)
        for name, rating in rows:
            country = map_name(name)
            key = country.lower()
            if key in seen:
                continue
            seen.add(key)
            writer.writerow([country, rating, snapshot])


# ── Orchestration ────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Fetch World Football Elo ratings → elo_ratings.csv")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    p.add_argument("--name-col", type=int, default=None, help="0-based column index for the team name.")
    p.add_argument("--rating-col", type=int, default=None, help="0-based column index for the rating.")
    p.add_argument("--date", default=date.today().isoformat(), help="snapshot_date (default: today).")
    p.add_argument("--append", action="store_true", help="Append a new snapshot instead of overwriting.")
    p.add_argument("--min-teams", type=int, default=50,
                   help="Abort without writing if fewer rows parse (guards against a bad fetch).")
    p.add_argument("--dry-run", action="store_true", help="Fetch + preview only; write nothing.")
    args = p.parse_args()

    text = fetch_tsv(args.url)
    rows = parse_ratings(text, args.name_col, args.rating_col)

    print(f"[parse] {len(rows)} team ratings parsed from {args.url}")
    for name, rating in rows[:5]:
        arrow = f" → {map_name(name)}" if map_name(name) != name else ""
        print(f"        {name}{arrow}: {rating}")

    if len(rows) < args.min_teams:
        sys.exit(
            f"[abort] Only {len(rows)} rows parsed (< --min-teams {args.min_teams}). "
            "Likely wrong URL or columns — existing CSV left untouched. "
            "Inspect the source (DevTools → Network → *.tsv) and pass "
            "--name-col / --rating-col."
        )

    if args.dry_run:
        print("[dry-run] No file written.")
        return

    write_csv(rows, args.output, args.date, args.append)
    print(f"[write] {len(rows)} ratings → {args.output}  (snapshot {args.date})")


if __name__ == "__main__":
    main()
