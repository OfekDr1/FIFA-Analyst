"""
simulate_tournament.py
======================

Monte-Carlo engine for the 2026 World Cup. Reads the locked Logistic-Regression
1X2 model + Elo from public/team_momentum.json, simulates the whole tournament
N times, and writes per-team advancement probabilities to
public/tournament_sim.json.

Match engine
  • Group + knockout outcomes are drawn from the LR model's pre-computed 1X2
    probabilities (an Elo-based fallback covers any pair the model never saw).
  • Knockout draws are resolved by an Elo-weighted — but dampened — shootout
    (shootouts are far more random than open play).

Format (2026): 48 teams · 12 groups of 4 · top 2 of each group + the 8 best
third-placed teams → Round of 32 → R16 → QF → SF → Final.

⚠️  The group draw (DEFAULT_GROUPS) and the R32 bracket (R32_BRACKET) are EDITABLE
    data structures below. Replace DEFAULT_GROUPS with the official draw — names
    MUST match team_momentum.json — and R32_BRACKET with the official slot
    pairings if you want exact bracket fidelity. The engine validates every team
    against the data and warns about anything it can't find.

Note: a 1X2 model has no scorelines, so group ties are broken by
points → head-to-head → Elo → random (no goal difference available).

Usage:
    python simulate_tournament.py
    python simulate_tournament.py --sims 50000 --seed 7
    python simulate_tournament.py --groups groups.json
"""

from __future__ import annotations

import argparse
import itertools
import json
import random
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from compute_momentum import normalize_name

SCRIPT_DIR = Path(__file__).resolve().parent

# ── Tunables ─────────────────────────────────────────────────────────
DEFAULT_SIMS = 10_000
DEFAULT_ELO = 1500.0
SHOOTOUT_ELO_WEIGHT = 0.5   # 0 = pure coin-flip, 1 = full Elo edge in shootouts
DRAW_BASE = 0.30            # peak draw rate for the Elo fallback (even teams)
STAGES = ["r32", "r16", "qf", "sf", "final", "win"]
GROUP_ORDER = list("ABCDEFGHIJKL")   # 12 groups

# ── EDITABLE: the group draw (names MUST match team_momentum.json) ────
# Placeholder template — REPLACE with the official 2026 draw.
DEFAULT_GROUPS = {
    "A": ["United States", "Croatia", "Australia", "Saudi Arabia"],
    "B": ["Mexico", "Italy", "Egypt", "Qatar"],
    "C": ["Canada", "Uruguay", "Ecuador", "Iraq"],
    "D": ["Argentina", "Colombia", "Austria", "Uzbekistan"],
    "E": ["France", "Morocco", "Ukraine", "Cameroon"],
    "F": ["England", "Japan", "Turkey", "Ghana"],
    "G": ["Brazil", "Senegal", "Serbia", "Tunisia"],
    "H": ["Spain", "Switzerland", "Poland", "Costa Rica"],
    "I": ["Portugal", "Denmark", "Algeria", "Panama"],
    "J": ["Netherlands", "Iran", "Ivory Coast", "Jamaica"],
    "K": ["Belgium", "South Korea", "Norway", "New Zealand"],
    "L": ["Germany", "Nigeria", "Peru", "Paraguay"],
}

# ── EDITABLE: R32 bracket as slot pairings ───────────────────────────
# Slots: "1X"=winner of group X, "2X"=runner-up, "T1..T8"=best thirds (ranked).
# The ORDER of the 16 matches defines the bracket tree (folded pairwise into the
# R16, then QF, SF, Final). This is a structurally-faithful default; swap in the
# official slot map for exact fidelity.
R32_BRACKET = [
    ("1A", "T1"), ("1C", "2D"),
    ("1E", "2F"), ("1G", "T2"),
    ("1I", "2J"), ("1B", "T3"),
    ("1L", "2K"), ("1D", "T4"),
    ("2A", "2C"), ("1F", "T5"),
    ("2E", "2G"), ("1H", "T6"),
    ("2I", "2L"), ("1K", "T7"),
    ("2B", "2H"), ("1J", "T8"),
]
R32_SLOT_ORDER = [s for match in R32_BRACKET for s in match]  # 32 slots, bracket order


# ── Probability model ────────────────────────────────────────────────
def elo_1x2(ea: float, eb: float) -> tuple[float, float, float]:
    """Fallback 1X2 from Elo when the LR model never saw this pair. Draw rate
    peaks for even teams and shrinks with the gap."""
    exp_a = 1.0 / (1.0 + 10 ** ((eb - ea) / 400.0))
    draw = DRAW_BASE * (1.0 - abs(2 * exp_a - 1.0))
    draw = min(0.40, max(0.06, draw))
    return exp_a * (1.0 - draw), draw, (1.0 - exp_a) * (1.0 - draw)


class SimContext:
    """Holds the draw + a pre-computed 1X2 table for every ordered pair of the
    48 teams, so the inner Monte-Carlo loop is just dict lookups (fast)."""

    def __init__(self, groups: dict, elo_map: dict, matchups: dict):
        self.groups = groups
        self.teams = [t for ts in groups.values() for t in ts]
        self.team_elo = {
            t: float(elo_map.get(normalize_name(t), DEFAULT_ELO)) for t in self.teams
        }
        self.fallbacks = 0
        self.pp: dict[tuple[str, str], tuple[float, float, float]] = {}
        for a, b in itertools.permutations(self.teams, 2):
            self.pp[(a, b)] = self._probs(a, b, matchups)

    def _probs(self, a: str, b: str, matchups: dict) -> tuple[float, float, float]:
        p = matchups.get(f"{normalize_name(a)}|{normalize_name(b)}")
        if p and len(p) >= 3 and sum(p[:3]) > 0:
            s = p[0] + p[1] + p[2]
            return p[0] / s, p[1] / s, p[2] / s
        self.fallbacks += 1
        return elo_1x2(self.team_elo[a], self.team_elo[b])

    def elo(self, t: str) -> float:
        return self.team_elo[t]


# ── Match simulation ─────────────────────────────────────────────────
def match_outcome(a: str, b: str, ctx: SimContext, rng: random.Random) -> str:
    """Roll the 1X2 dice → 'A' (a wins), 'D' (draw), or 'B' (b wins)."""
    pa, pd, _ = ctx.pp[(a, b)]
    r = rng.random()
    if r < pa:
        return "A"
    if r < pa + pd:
        return "D"
    return "B"


def knockout_winner(a: str, b: str, ctx: SimContext, rng: random.Random) -> str:
    """Knockout match: a draw goes to an Elo-weighted (dampened) shootout."""
    o = match_outcome(a, b, ctx, rng)
    if o == "A":
        return a
    if o == "B":
        return b
    wa = 1.0 / (1.0 + 10 ** ((ctx.elo(b) - ctx.elo(a)) / 400.0))
    wa = 0.5 + (wa - 0.5) * SHOOTOUT_ELO_WEIGHT  # pull toward a coin flip
    return a if rng.random() < wa else b


def knockout_round(teams: list[str], ctx: SimContext, rng: random.Random) -> list[str]:
    return [knockout_winner(teams[i], teams[i + 1], ctx, rng)
            for i in range(0, len(teams), 2)]


# ── Group stage ──────────────────────────────────────────────────────
def rank_group(teams, pts, played, ctx, rng) -> list[str]:
    """points → head-to-head (among tied) → Elo → random. No GD: 1X2 has no
    scorelines, so Elo stands in for the goal-based FIFA tiebreakers."""

    def h2h(team, tied) -> int:
        s = 0
        for other in tied:
            if other == team:
                continue
            o = played.get((team, other))
            if o is None:                       # match was stored as (other, team)
                o = played.get((other, team))
                s += 3 if o == "B" else (1 if o == "D" else 0)
            else:
                s += 3 if o == "A" else (1 if o == "D" else 0)
        return s

    ordered = sorted(teams, key=lambda t: pts[t], reverse=True)
    result: list[str] = []
    for _, grp in itertools.groupby(ordered, key=lambda t: pts[t]):
        tied = list(grp)
        if len(tied) > 1:
            tied.sort(key=lambda t: (h2h(t, tied), ctx.elo(t), rng.random()), reverse=True)
        result.extend(tied)
    return result


def play_group(teams, ctx, rng) -> tuple[list[str], dict]:
    pts = {t: 0 for t in teams}
    played: dict[tuple[str, str], str] = {}
    for a, b in itertools.combinations(teams, 2):
        o = match_outcome(a, b, ctx, rng)
        played[(a, b)] = o
        if o == "A":
            pts[a] += 3
        elif o == "B":
            pts[b] += 3
        else:
            pts[a] += 1
            pts[b] += 1
    return rank_group(teams, pts, played, ctx, rng), pts


# ── One full tournament ──────────────────────────────────────────────
def run_one_sim(ctx: SimContext, rng: random.Random) -> dict[str, set]:
    slot: dict[str, str] = {}
    thirds = []
    for g in GROUP_ORDER:
        ranked, pts = play_group(ctx.groups[g], ctx, rng)
        slot[f"1{g}"], slot[f"2{g}"] = ranked[0], ranked[1]
        if len(ranked) >= 3:
            thirds.append((ranked[2], pts[ranked[2]], ctx.elo(ranked[2])))

    # 8 best third-placed teams: points → Elo → random.
    thirds.sort(key=lambda x: (x[1], x[2], rng.random()), reverse=True)
    for i, (team, _, _) in enumerate(thirds[:8]):
        slot[f"T{i + 1}"] = team

    reached = {k: set() for k in STAGES}
    teams = [slot[s] for s in R32_SLOT_ORDER]   # 32 qualifiers in bracket order
    reached["r32"].update(teams)
    for stage in ("r16", "qf", "sf", "final"):
        teams = knockout_round(teams, ctx, rng)
        reached[stage].update(teams)
    reached["win"].add(knockout_winner(teams[0], teams[1], ctx, rng))
    return reached


def simulate(ctx: SimContext, n: int, seed: int) -> dict[str, Counter]:
    rng = random.Random(seed)
    counts = {s: Counter() for s in STAGES}
    for _ in range(n):
        reached = run_one_sim(ctx, rng)
        for s in STAGES:
            counts[s].update(reached[s])
    return counts


# ── IO + orchestration ───────────────────────────────────────────────
def load_model(path: Path) -> tuple[dict, dict]:
    if not path.exists():
        sys.exit(f"[fatal] {path} not found — run compute_momentum.py first.")
    data = json.loads(path.read_text(encoding="utf-8"))
    elo_map = {
        normalize_name(e["team"]): float(e["elo"])
        for e in data.get("teams", [])
        if isinstance(e, dict) and e.get("team") and e.get("elo") is not None
    }
    matchups = (data.get("model") or {}).get("matchups") or {}
    if not matchups:
        print("[warn] no model.matchups found — every match will use the Elo fallback.")
    return elo_map, matchups


def main() -> None:
    p = argparse.ArgumentParser(description="Monte-Carlo the 2026 World Cup.")
    p.add_argument("--input", type=Path, default=SCRIPT_DIR / ".." / "public" / "team_momentum.json")
    p.add_argument("--output", type=Path, default=SCRIPT_DIR / ".." / "public" / "tournament_sim.json")
    p.add_argument("--groups", type=Path, default=None, help="JSON file overriding DEFAULT_GROUPS.")
    p.add_argument("--sims", type=int, default=DEFAULT_SIMS)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    elo_map, matchups = load_model(args.input)
    groups = json.loads(args.groups.read_text(encoding="utf-8")) if args.groups else DEFAULT_GROUPS

    # ── Validate the draw against the data (catch silent name mismatches) ──
    if sorted(groups) != GROUP_ORDER:
        print(f"[warn] expected 12 groups A–L; got {sorted(groups)} — bracket slots may misalign.")
    wc_teams = [t for ts in groups.values() for t in ts]
    unknown = sorted({t for t in wc_teams if normalize_name(t) not in elo_map})
    if unknown:
        print(f"[warn] {len(unknown)} team(s) not in team_momentum.json "
              f"(default Elo {int(DEFAULT_ELO)} + fallback odds): {', '.join(unknown)}")

    ctx = SimContext(groups, elo_map, matchups)
    total_pairs = len(wc_teams) * (len(wc_teams) - 1)
    print(f"[info] {len(wc_teams)} teams · {args.sims} sims · "
          f"{ctx.fallbacks}/{total_pairs} matchups via Elo fallback "
          f"({100 * ctx.fallbacks / total_pairs:.1f}%).")

    counts = simulate(ctx, args.sims, args.seed)

    team_group = {t: g for g, ts in groups.items() for t in ts}
    n = float(args.sims)
    rows = [{
        "team": t,
        "group": team_group[t],
        "elo": round(ctx.elo(t)),
        "reach_r32": round(counts["r32"][t] / n, 4),
        "reach_r16": round(counts["r16"][t] / n, 4),
        "reach_qf": round(counts["qf"][t] / n, 4),
        "reach_sf": round(counts["sf"][t] / n, 4),
        "reach_final": round(counts["final"][t] / n, 4),
        "win": round(counts["win"][t] / n, 4),
    } for t in wc_teams]
    rows.sort(key=lambda r: r["win"], reverse=True)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "simulations": args.sims,
        "format": "48 teams · 12 groups · top 2 + 8 best thirds → R32 → R16 → QF → SF → Final",
        "teams": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"✓ Wrote {args.output}")

    print("\nTop 10 title favourites:")
    print(f"  {'team':<18}{'Win':>7}{'Final':>8}{'SF':>7}{'R16':>7}")
    for r in rows[:10]:
        print(f"  {r['team']:<18}{r['win']*100:>6.1f}%{r['reach_final']*100:>7.1f}%"
              f"{r['reach_sf']*100:>6.1f}%{r['reach_r16']*100:>6.1f}%")


if __name__ == "__main__":
    main()
