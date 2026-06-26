"""
refresh_data.py
===============

One-shot daily refresh for the live tournament feed. Runs the full
ingest → recompute pipeline in the correct order, resiliently:

    1. fetch_elo.py          → refresh elo_ratings.csv (latest Elo snapshot)
    2. fetch_api_results.py  → append any new FINISHED matches (NO recompute yet)
    3. compute_momentum.py   → ONE rebuild of team_momentum.json using the
                               fresh Elo + any new results

Why an orchestrator (instead of just cron-ing fetch_api_results.py)?
  • Order matters: Elo must refresh BEFORE the recompute so the join is current.
  • fetch_api_results.py skips the recompute when there are no new matches — but
    we still want the fresh Elo to flow into the JSON every day. So step 3 runs
    unconditionally.
  • Steps 1 & 2 are NON-fatal: a network blip on the Elo scrape shouldn't stop
    the rebuild. Only the final recompute is treated as critical.

Designed to be driven by a scheduler (Windows Task Scheduler / cron / GitHub
Action). Exit code is 0 only if the recompute succeeded.

Usage:
    python refresh_data.py
    python refresh_data.py --skip-elo            # don't re-scrape Elo
    python refresh_data.py --skip-results        # don't poll the results API
    python refresh_data.py --output ../public/team_momentum.json
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def run_step(label: str, args: list[str], *, critical: bool = False) -> bool:
    """Run one pipeline script as a subprocess. Returns True on success.
    Non-critical failures are logged and swallowed so the pipeline continues."""
    print(f"\n── {label} ─────────────────────────────────────────")
    result = subprocess.run([sys.executable, *args], cwd=SCRIPT_DIR)
    ok = result.returncode == 0
    if ok:
        print(f"[ok] {label}")
    elif critical:
        print(f"[FAIL] {label} (exit {result.returncode}) — aborting refresh.")
    else:
        print(f"[warn] {label} (exit {result.returncode}) — continuing with existing data.")
    return ok


def main() -> None:
    p = argparse.ArgumentParser(description="Daily refresh: Elo → results → recompute → simulate.")
    p.add_argument("--output", default="../public/team_momentum.json",
                   help="Path forwarded to compute_momentum.py --output.")
    p.add_argument("--skip-elo", action="store_true", help="Don't re-scrape Elo ratings.")
    p.add_argument("--skip-results", action="store_true", help="Don't poll the results API.")
    p.add_argument("--skip-sim", action="store_true", help="Don't run the Monte-Carlo sim.")
    args = p.parse_args()

    started = datetime.now(timezone.utc)
    print(f"╔═ Data refresh started {started.isoformat(timespec='seconds')} ═╗")

    elo_ok = run_step("1/4 Refresh Elo ratings", ["fetch_elo.py"]) if not args.skip_elo \
        else (print("\n── 1/4 Refresh Elo — skipped ──"), True)[1]

    results_ok = run_step("2/4 Fetch new results",
                          ["fetch_api_results.py", "--no-recompute"]) \
        if not args.skip_results \
        else (print("\n── 2/4 Fetch results — skipped ──"), True)[1]

    # Always rebuild — fresh Elo should reach the JSON even with no new matches.
    rebuilt = run_step("3/4 Recompute team_momentum.json",
                       ["compute_momentum.py", "--output", args.output],
                       critical=True)

    # 4) Monte-Carlo the tournament from the FRESH model. Needs step 3's JSON, so
    #    it only runs if the recompute succeeded. Non-critical: a sim hiccup must
    #    not block the core data refresh.
    if not rebuilt:
        sim_ok = False
        print("\n── 4/4 Simulate tournament — skipped (recompute failed) ──")
    elif args.skip_sim:
        sim_ok = True
        print("\n── 4/4 Simulate tournament — skipped (--skip-sim) ──")
    else:
        sim_ok = run_step("4/4 Simulate tournament",
                          ["simulate_tournament.py", "--input", args.output])

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    print("\n╔═ Summary ═╗")
    print(f"  Elo refresh    : {'ok' if elo_ok else 'skipped/failed'}")
    print(f"  Results fetch  : {'ok' if results_ok else 'skipped/failed'}")
    print(f"  Recompute JSON : {'ok' if rebuilt else 'FAILED'}")
    print(f"  Tournament sim : {'ok' if sim_ok else 'skipped/failed'}")
    print(f"  Elapsed        : {elapsed:.1f}s")

    if not rebuilt:
        sys.exit("Refresh failed — team_momentum.json was NOT updated.")
    print("\n✓ Live feed refreshed — team_momentum.json + tournament_sim.json current.")


if __name__ == "__main__":
    main()
