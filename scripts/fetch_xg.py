"""
fetch_xg.py
===========

Replace the hand-typed team_xg_stats.csv with REAL data, via a fallback ladder
so EVERY team gets a real, individualised value — no fabricated numbers, no flat
1.10 constant:

    1. Real Opta xG from FBref (soccerdata) for covered international matches.
    2. Fallback → real goals-for / goals-against per 90 from results.csv
       (100% coverage; international matches are 90', so per-match means ≈ /90).

The FBref layer is BEST-EFFORT and fully guarded: if soccerdata isn't installed,
the network/league codes fail, or a competition carries no xG, those teams simply
fall back to the goals-per-90 base. The script ALWAYS writes a valid, fully-real
CSV — running it can only improve on the hand-typed file it replaces.

Output columns (consumed by compute_momentum.load_xg): team, xG_per_90, xGA_per_90

Usage:
    pip install soccerdata            # only needed for the real-xG layer
    python fetch_xg.py                # goals base + FBref overlay where available
    python fetch_xg.py --no-fbref     # goals-per-90 only (zero scraping)
    python fetch_xg.py --list-leagues # print soccerdata's valid FBref league codes
    python fetch_xg.py --dry-run      # preview, write nothing
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from compute_momentum import (
    load_and_filter,
    to_team_perspective,
    normalize_name,
    DEFAULT_SINCE,
)

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT = SCRIPT_DIR / "team_xg_stats.csv"

# soccerdata's FBref only exposes the World Cup + Euros for international MEN's
# football — there is NO Copa America / AFCON / Asian Cup / Gold Cup / Nations
# League / qualifiers feed. So real xG is limited to those editions that fall
# inside the window; every other team falls back to real goals-per-90 (exactly
# what the ladder is for). Listed as explicit (competition, season) pairs so we
# never request an edition that doesn't exist (e.g. a Euro in 2026).
DEFAULT_EDITIONS = [
    ("INT-European Championship", "2024"),  # Euro 2024 — full tournament, ~24 UEFA sides
    ("INT-World Cup", "2026"),              # WC 2026 (live) — xG accrues as it's played
    # ("INT-World Cup", "2022"),            # enable AND pass --since 2022-06-01 to include it
]

# FBref spellings → results.csv names (only where they genuinely differ; the join
# normalises case/accents on top of this).
FBREF_NAME_MAP = {
    "Korea Republic": "South Korea", "Korea DPR": "North Korea",
    "IR Iran": "Iran", "Czechia": "Czech Republic",
    "Côte d'Ivoire": "Ivory Coast", "Cabo Verde": "Cape Verde",
    "Türkiye": "Turkey", "Turkiye": "Turkey", "Congo DR": "DR Congo",
    "United States": "United States", "China PR": "China PR",
}

# Implausible team rates → flag (real WC sides sit well inside these).
MAX_XG, MAX_XGA = 4.0, 5.0


# ── Tier 2: real goals-per-90 from results.csv (the reliable base) ────
def goals_base(df: pd.DataFrame) -> pd.DataFrame:
    """Per-team mean goals scored / conceded over the window (≈ per 90)."""
    tp = to_team_perspective(df)
    g = tp.groupby("team", as_index=False).agg(
        matches=("goals_for", "size"),
        gf=("goals_for", "mean"),
        ga=("goals_against", "mean"),
    )
    return g


# ── Tier 1: real Opta xG from FBref (best-effort overlay) ─────────────
def _col(frame: pd.DataFrame, *names: str):
    """Return the first column whose normalised name matches, else None."""
    lut = {str(c).lower().replace(" ", "_"): c for c in frame.columns}
    for n in names:
        if n in lut:
            return frame[lut[n]]
    return None


def fbref_xg(since: str, editions: list[tuple[str, str]]) -> dict[str, tuple[float, float]]:
    """{normalised team → (xG/90, xGA/90)} aggregated across the given
    (competition, season) editions. Returns {} (and logs why) on any failure —
    the caller then falls back to real goals-per-90."""
    try:
        import soccerdata as sd
    except ImportError:
        print("[xg] soccerdata not installed — skipping FBref layer "
              "(`pip install soccerdata`). Using goals-per-90 for everyone.")
        return {}

    since_ts = pd.Timestamp(since)
    acc: dict[str, list[float]] = {}  # key → [xg_for_sum, xga_sum, n]
    covered = 0

    for comp, season in editions:
        try:
            sched = sd.FBref(leagues=comp, seasons=season).read_schedule()
        except Exception as err:  # network, bad code, empty edition, parse change…
            print(f"[xg] {comp} {season}: skipped ({type(err).__name__}).")
            continue

        home = _col(sched, "home_team")
        away = _col(sched, "away_team")
        hxg = _col(sched, "home_xg")
        axg = _col(sched, "away_xg")
        date = _col(sched, "date")
        if home is None or away is None or hxg is None or axg is None:
            print(f"[xg] {comp} {season}: no xG columns — skipped.")
            continue

        dates = pd.to_datetime(date, errors="coerce") if date is not None else None
        rows = 0
        for i in range(len(sched)):
            if dates is not None and (pd.isna(dates.iloc[i]) or dates.iloc[i] < since_ts):
                continue
            hx, ax = hxg.iloc[i], axg.iloc[i]
            if pd.isna(hx) or pd.isna(ax):
                continue
            h = normalize_name(FBREF_NAME_MAP.get(str(home.iloc[i]), str(home.iloc[i])))
            a = normalize_name(FBREF_NAME_MAP.get(str(away.iloc[i]), str(away.iloc[i])))
            acc.setdefault(h, [0.0, 0.0, 0]); acc.setdefault(a, [0.0, 0.0, 0])
            acc[h][0] += float(hx); acc[h][1] += float(ax); acc[h][2] += 1
            acc[a][0] += float(ax); acc[a][1] += float(hx); acc[a][2] += 1
            rows += 1
        if rows:
            covered += 1
            print(f"[xg] {comp} {season}: +{rows} matches with xG.")

    if not covered:
        print("[xg] FBref returned no xG — check `--list-leagues`. Falling back to goals.")
    return {k: (v[0] / v[2], v[1] / v[2]) for k, v in acc.items() if v[2] > 0}


# ── Orchestration ────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Build a REAL team_xg_stats.csv (FBref xG → goals/90 fallback).")
    p.add_argument("--input", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--output", type=Path, default=OUTPUT)
    p.add_argument("--since", default=DEFAULT_SINCE)
    p.add_argument("--no-fbref", action="store_true", help="Skip the FBref layer (goals/90 only).")
    p.add_argument("--list-leagues", action="store_true", help="Print valid FBref league codes and exit.")
    p.add_argument("--dry-run", action="store_true", help="Preview; write nothing.")
    args = p.parse_args()

    if args.list_leagues:
        try:
            import soccerdata as sd
            print("\n".join(sorted(sd.FBref.available_leagues())))
        except Exception as err:
            sys.exit(f"Could not list leagues ({err}). Is soccerdata installed?")
        return

    df = load_and_filter(args.input, args.since)
    if df.empty:
        sys.exit("No competitive matches in the window — nothing to build.")

    base = goals_base(df)
    fb = {} if args.no_fbref else fbref_xg(args.since, DEFAULT_EDITIONS)

    rows, n_real, warnings = [], 0, []
    for _, r in base.iterrows():
        key = normalize_name(r["team"])
        if key in fb:
            xg, xga = fb[key]
            n_real += 1
        else:
            xg, xga = float(r["gf"]), float(r["ga"])
        xg, xga = round(xg, 2), round(xga, 2)
        if xg > MAX_XG or xga > MAX_XGA or xg < 0 or xga < 0:
            warnings.append(f"{r['team']} (xG {xg}, xGA {xga})")
        rows.append({"team": r["team"], "xG_per_90": xg, "xGA_per_90": xga})

    out = pd.DataFrame(rows).sort_values("team").reset_index(drop=True)

    total = len(out)
    print(f"\n[xg] {total} teams · {n_real} with REAL FBref xG · "
          f"{total - n_real} via real goals-per-90 fallback "
          f"({100 * n_real / total:.0f}% true xG).")
    if warnings:
        print(f"[xg] {len(warnings)} implausible row(s) to eyeball: {', '.join(warnings[:8])}")

    print("\nPreview (top sides by xG):")
    for _, r in out.sort_values("xG_per_90", ascending=False).head(8).iterrows():
        print(f"  {r['team']:<18} xG {r['xG_per_90']:.2f}  xGA {r['xGA_per_90']:.2f}")

    if args.dry_run:
        print("\n[dry-run] Nothing written.")
        return
    out.to_csv(args.output, index=False, encoding="utf-8")
    print(f"\n✓ Wrote {args.output} — re-run compute_momentum.py (or refresh_data.py) to use it.")


if __name__ == "__main__":
    main()
