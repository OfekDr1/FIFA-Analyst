"""
compute_elo.py
==============

Point-in-time Elo, computed in-house by replaying the ENTIRE results.csv history
(1872 → today) chronologically with the World Football Elo formula
(eloratings.net convention):

    We   = 1 / (1 + 10^(-(Rh + 100·home - Ra) / 400))     (+100 only if not neutral)
    R'   = R + K · G · (W - We)
    K    = 60 World Cup finals · 50 continental finals · 40 qualifiers/Nations
           League · 30 other competitive · 20 friendlies
    G    = 1 (margin ≤1) · 1.5 (margin 2) · (11+margin)/8 (margin ≥3)

Why in-house instead of the eloratings.net snapshot?  The snapshot only tells us
ratings TODAY. Training on a decade of matches needs each team's rating AS OF
each match date — otherwise a 2016 fixture gets described by 2026 strength
(leakage + stale context). The replay yields exactly that, for every team, from
nothing but real results.

Library use:
    from compute_elo import attach_replay_elo
    df, final_ratings = attach_replay_elo(df)   # adds elo_h_pre / elo_a_pre

CLI (sanity check + snapshot export):
    python compute_elo.py                # replay → elo_inhouse.csv + top-15 +
                                         # rank-correlation vs elo_ratings.csv
"""

from __future__ import annotations

import argparse
import unicodedata
from pathlib import Path

import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_RATING = 1500.0
HOME_ADV = 100.0

# NOTE: deliberately self-contained (no compute_momentum import) to avoid a
# circular dependency — compute_momentum imports THIS module.


def _norm(name: object) -> str:
    text = unicodedata.normalize("NFKD", str(name))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.strip().lower()


def k_factor(tournament: object) -> float:
    t = str(tournament).lower()
    if "friendly" in t:
        return 20.0
    if "qualif" in t or "nations league" in t:
        return 40.0
    if "world cup" in t:
        return 60.0
    finals = ("euro", "copa am", "africa cup", "afcon",
              "asian cup", "gold cup", "confederations")
    if any(f in t for f in finals):
        return 50.0
    return 30.0


def goal_multiplier(margin: int) -> float:
    if margin <= 1:
        return 1.0
    if margin == 2:
        return 1.5
    return (11.0 + margin) / 8.0


def _is_neutral(val: object) -> bool:
    return str(val).strip().lower() in ("true", "1", "yes", "t")


def attach_replay_elo(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float]]:
    """Replay `df` (MUST be date-sorted; friendlies included — they move ratings
    too, at low K) and return (df + elo_h_pre/elo_a_pre columns, final ratings
    keyed by normalised team name). Pre-match ratings only → zero leakage."""
    ratings: dict[str, float] = {}
    eh_pre: list[float] = []
    ea_pre: list[float] = []

    for m in df.itertuples(index=False):
        h, a = _norm(m.home_team), _norm(m.away_team)
        rh = ratings.get(h, DEFAULT_RATING)
        ra = ratings.get(a, DEFAULT_RATING)
        eh_pre.append(rh)
        ea_pre.append(ra)

        home_bonus = 0.0 if _is_neutral(getattr(m, "neutral", "TRUE")) else HOME_ADV
        we_h = 1.0 / (1.0 + 10 ** (-((rh + home_bonus) - ra) / 400.0))
        hs, as_ = int(m.home_score), int(m.away_score)
        w_h = 1.0 if hs > as_ else 0.5 if hs == as_ else 0.0
        delta = k_factor(m.tournament) * goal_multiplier(abs(hs - as_)) * (w_h - we_h)
        ratings[h] = rh + delta
        ratings[a] = ra - delta

    out = df.copy()
    out["elo_h_pre"] = eh_pre
    out["elo_a_pre"] = ea_pre
    return out, ratings


def load_history(path: Path) -> pd.DataFrame:
    """All playable matches (friendlies included), date-sorted."""
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date", "home_score", "away_score"])
    df["home_score"] = df["home_score"].astype(int)
    df["away_score"] = df["away_score"].astype(int)
    return df.sort_values("date").reset_index(drop=True)


# ── CLI: snapshot + sanity check ─────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Replay results.csv → in-house point-in-time Elo.")
    p.add_argument("--input", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--output", type=Path, default=SCRIPT_DIR / "elo_inhouse.csv")
    p.add_argument("--reference", type=Path, default=SCRIPT_DIR / "elo_ratings.csv",
                   help="eloratings.net snapshot to cross-validate against.")
    args = p.parse_args()

    df = load_history(args.input)
    print(f"[replay] {len(df)} matches ({df['date'].min().date()} → {df['date'].max().date()})")
    _, final = attach_replay_elo(df)

    snap = (pd.DataFrame(sorted(final.items(), key=lambda kv: -kv[1]),
                         columns=["team", "elo_inhouse"])
            .round({"elo_inhouse": 1}))
    snap.to_csv(args.output, index=False)
    print(f"[replay] wrote {len(snap)} team ratings → {args.output}\n")

    print("Top 15 (in-house):")
    for _, r in snap.head(15).iterrows():
        print(f"  {r['team']:<22}{r['elo_inhouse']:>8.0f}")

    # Cross-check against the eloratings.net snapshot — high rank correlation
    # validates the replay; a big miss means a formula/name bug.
    if args.reference.exists():
        ref = pd.read_csv(args.reference)
        ref["_key"] = ref["country"].map(_norm)
        ref = ref.drop_duplicates("_key")[["_key", "rating"]]
        merged = snap.assign(_key=snap["team"]).merge(ref, on="_key")
        rho = merged["elo_inhouse"].corr(merged["rating"], method="spearman")
        print(f"\n[check] vs eloratings.net: {len(merged)} common teams · "
              f"Spearman rank correlation {rho:.3f} "
              f"({'OK — replay tracks reality' if rho > 0.85 else '⚠ LOW — inspect the formula/names'})")


if __name__ == "__main__":
    main()
