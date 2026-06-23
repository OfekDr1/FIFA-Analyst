"""
add_result.py
=============

Quickly log a finished match into results.csv and refresh team_momentum.json
(re-runs the whole momentum / Elo-join / xG / ML pipeline).

Usage:
    python add_result.py "Norway" 2 1 "Italy"
        → Norway 2-1 Italy, dated today, tournament "FIFA World Cup",
          then runs compute_momentum.py automatically.

Options:
    --date 2026-06-23        # override the match date (default: today)
    --tournament "..."        # default: "FIFA World Cup"
    --neutral FALSE           # host-nation game (default: TRUE)
    --no-recompute            # just append the row, don't rebuild the JSON
    --output ../public/team_momentum.json   # where the JSON is written
"""

from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_TOURNAMENT = "FIFA World Cup"

# Canonical column order for the international-results dataset.
COLUMNS = [
    "date", "home_team", "away_team", "home_score", "away_score",
    "tournament", "city", "country", "neutral",
]


def main() -> None:
    p = argparse.ArgumentParser(
        description="Append a match result to results.csv and refresh team_momentum.json."
    )
    # Positional: HOME  HOME_SCORE  AWAY_SCORE  AWAY
    p.add_argument("home_team")
    p.add_argument("home_score", type=int)
    p.add_argument("away_score", type=int)
    p.add_argument("away_team")

    p.add_argument("--results", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--date", default=date.today().isoformat(),
                   help="Match date YYYY-MM-DD (default: today).")
    p.add_argument("--tournament", default=DEFAULT_TOURNAMENT)
    p.add_argument("--city", default="")
    p.add_argument("--country", default="")
    p.add_argument("--neutral", default="TRUE", choices=["TRUE", "FALSE"])
    p.add_argument("--output", default="../public/team_momentum.json",
                   help="Path forwarded to compute_momentum.py --output.")
    p.add_argument("--no-recompute", action="store_true",
                   help="Append the row but skip rebuilding the JSON.")
    args = p.parse_args()

    if args.tournament.strip().lower() == "friendly":
        sys.exit("Refusing 'Friendly' — the pipeline filters those out; use a competitive name.")

    row = {
        "date": args.date,
        "home_team": args.home_team,
        "away_team": args.away_team,
        "home_score": args.home_score,
        "away_score": args.away_score,
        "tournament": args.tournament,
        "city": args.city,
        "country": args.country,
        "neutral": args.neutral,
    }

    # Match the existing file's header order if present; else use COLUMNS.
    fieldnames = COLUMNS
    has_rows = args.results.exists() and args.results.stat().st_size > 0
    if has_rows:
        with args.results.open("r", encoding="utf-8", newline="") as f:
            header = next(csv.reader(f), None)
        if header:
            fieldnames = header

    # Append (newline="" so csv doesn't add blank lines on Windows).
    with args.results.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if not has_rows:
            writer.writeheader()
        writer.writerow({col: row.get(col, "") for col in fieldnames})

    print(f"✓ Logged: {args.date} | {args.home_team} {args.home_score}–"
          f"{args.away_score} {args.away_team}  ({args.tournament})")
    print(f"  → {args.results}")

    if args.no_recompute:
        print("Skipped recompute (--no-recompute). Run compute_momentum.py when ready.")
        return

    # Rebuild momentum / Elo / xG / ML model and re-export the JSON.
    cmd = [sys.executable, str(SCRIPT_DIR / "compute_momentum.py"), "--output", args.output]
    print(f"→ {' '.join(cmd)}\n")
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        sys.exit(f"\ncompute_momentum.py failed (exit {result.returncode}).")
    print("\n✓ team_momentum.json refreshed — reload the dashboard.")


if __name__ == "__main__":
    main()
