"""
simulate_tournament.py — LIVE forecast
======================================

Monte-Carlo engine for the 2026 World Cup that conditions on reality: it locks in
matches already played (from results.csv) and only simulates the fixtures that
haven't happened yet. As the tournament unfolds, odds sharpen, qualified teams
lock in, and eliminated teams fall to 0% automatically.

Pipeline per run
  1. GROUP STAGE — for every pair in a group: if that match was actually played
     (found in results.csv), use the REAL result (real points + real goal diff);
     otherwise Monte-Carlo it. Rank by points → GD → head-to-head → random.
  2. Top 2 of each group + 8 best third-placed → fill the R32 bracket.
  3. KNOCKOUTS — for each bracket tie: if those two teams actually played a WC
     knockout (a cross-group result in results.csv), lock the real winner; else
     simulate, resolving draws by an Elo-weighted (dampened) shootout.

Eliminations need no special-casing: a team whose real results are locked simply
can't advance, so its probability converges to 0 across the runs.

⚠️  DATA YOU MUST SUPPLY
  • The real draw → create scripts/groups.json: {"A": ["Team", …4], … "L": […]}.
    Names MUST match team_momentum.json / results.csv. Without it the engine runs
    on a PLACEHDER template (clearly flagged) so nothing crashes.
  • For deep knockout locking to stay consistent once the bracket is underway,
    R32_BRACKET below should match FIFA's official slot pairings. It ships a
    structurally-valid default; edit it to the official bracket when you have it.

Note: a 1X2 model has no scorelines, so SIMULATED group matches contribute a
nominal ±1 goal margin; PLAYED matches contribute their real GD. Real GD always
dominates once games are on the board.

Usage:
    python simulate_tournament.py
    python simulate_tournament.py --sims 50000 --seed 7
    python simulate_tournament.py --groups groups.json --results results.csv
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

import pandas as pd

from compute_momentum import normalize_name

SCRIPT_DIR = Path(__file__).resolve().parent

# ── Tunables ─────────────────────────────────────────────────────────
DEFAULT_SIMS = 10_000
DEFAULT_ELO = 1500.0
SHOOTOUT_ELO_WEIGHT = 0.5
DRAW_BASE = 0.30
WC_TOURNAMENT = "fifa world cup"     # results.csv `tournament` value to treat as WC
WC_SINCE = "2026-06-01"              # only THIS edition's matches count as live
STAGES = ["r32", "r16", "qf", "sf", "final", "win"]
GROUP_ORDER = list("ABCDEFGHIJKL")

# ── PLACEHOLDER draw — replace via scripts/groups.json (the real draw) ─
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

# ── EDITABLE R32 bracket (slot pairings) — align to the official bracket ──
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
R32_SLOT_ORDER = [s for match in R32_BRACKET for s in match]


# ── Probability model ────────────────────────────────────────────────
def elo_1x2(ea: float, eb: float) -> tuple[float, float, float]:
    exp_a = 1.0 / (1.0 + 10 ** ((eb - ea) / 400.0))
    draw = min(0.40, max(0.06, DRAW_BASE * (1.0 - abs(2 * exp_a - 1.0))))
    return exp_a * (1.0 - draw), draw, (1.0 - exp_a) * (1.0 - draw)


def pkey(a: str, b: str) -> tuple[str, str]:
    return tuple(sorted((normalize_name(a), normalize_name(b))))  # type: ignore


# ── Reality: lock in played WC matches ───────────────────────────────
def load_played_wc(results_path: Path, groups: dict, since: str):
    """Split played WC matches into group results (same-group) and knockout
    results (cross-group). Returns (group_results, ko_results, n_group, n_ko,
    unknown_teams, last_date)."""
    name_to_group = {normalize_name(t): g for g, ts in groups.items() for t in ts}
    grp: dict[tuple, tuple[int, int]] = {}   # (lo,hi) → (goals_lo, goals_hi)
    ko: dict[tuple, str | None] = {}         # (lo,hi) → normalised winner | None(draw)
    unknown: set[str] = set()
    last_date = None

    if not results_path.exists():
        return grp, ko, 0, 0, unknown, last_date
    df = pd.read_csv(results_path)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date", "home_score", "away_score"])
    since_ts = pd.Timestamp(since)

    for _, m in df.iterrows():
        if str(m.get("tournament", "")).strip().lower() != WC_TOURNAMENT:
            continue
        if m["date"] < since_ts:
            continue
        nh, na = normalize_name(m["home_team"]), normalize_name(m["away_team"])
        gh, ga = name_to_group.get(nh), name_to_group.get(na)
        if gh is None:
            unknown.add(str(m["home_team"]))
        if ga is None:
            unknown.add(str(m["away_team"]))
        if gh is None or ga is None:
            continue
        hs, as_ = int(m["home_score"]), int(m["away_score"])
        last_date = m["date"] if last_date is None else max(last_date, m["date"])
        lo, hi = sorted((nh, na))
        g_lo, g_hi = (hs, as_) if nh == lo else (as_, hs)
        if gh == ga:                                   # same group → group match
            grp[(lo, hi)] = (g_lo, g_hi)
        else:                                          # cross group → knockout
            ko[(lo, hi)] = lo if g_lo > g_hi else hi if g_hi > g_lo else None
    return grp, ko, len(grp), len(ko), unknown, last_date


def current_standings(groups: dict, grp: dict) -> dict[str, dict]:
    """Real points / GD / played so far, from locked group results only."""
    out = {normalize_name(t): {"played": 0, "points": 0, "gd": 0}
           for ts in groups.values() for t in ts}
    for (lo, hi), (g_lo, g_hi) in grp.items():
        for team, gf, ga in ((lo, g_lo, g_hi), (hi, g_hi, g_lo)):
            if team in out:
                s = out[team]
                s["played"] += 1
                s["gd"] += gf - ga
                s["points"] += 3 if gf > ga else (1 if gf == ga else 0)
    return out


# ── Context ──────────────────────────────────────────────────────────
class SimContext:
    def __init__(self, groups, elo_map, matchups, grp_res, ko_res):
        self.groups = groups
        self.teams = [t for ts in groups.values() for t in ts]
        self.team_elo = {t: float(elo_map.get(normalize_name(t), DEFAULT_ELO)) for t in self.teams}
        self.grp_res = grp_res
        self.ko_res = ko_res
        self.fallbacks = 0
        self.pp = {}
        for a, b in itertools.permutations(self.teams, 2):
            self.pp[(a, b)] = self._probs(a, b, matchups)

    def _probs(self, a, b, matchups):
        p = matchups.get(f"{normalize_name(a)}|{normalize_name(b)}")
        if p and len(p) >= 3 and sum(p[:3]) > 0:
            s = p[0] + p[1] + p[2]
            return p[0] / s, p[1] / s, p[2] / s
        self.fallbacks += 1
        return elo_1x2(self.team_elo[a], self.team_elo[b])

    def elo(self, t):
        return self.team_elo[t]

    # Group match: (outcome, goal-margin for a). Real if played, else simulated.
    def group_match(self, a, b, rng):
        lo, hi = sorted((normalize_name(a), normalize_name(b)))
        if (lo, hi) in self.grp_res:
            g_lo, g_hi = self.grp_res[(lo, hi)]
            ga, gb = (g_lo, g_hi) if normalize_name(a) == lo else (g_hi, g_lo)
            return ("A" if ga > gb else "B" if gb > ga else "D"), ga - gb
        pa, pd, _ = self.pp[(a, b)]
        r = rng.random()
        if r < pa:
            return "A", 1
        if r < pa + pd:
            return "D", 0
        return "B", -1

    # Knockout: real winner if the tie was actually played, else simulate.
    def knockout_winner(self, a, b, rng):
        lo, hi = sorted((normalize_name(a), normalize_name(b)))
        if (lo, hi) in self.ko_res:
            win = self.ko_res[(lo, hi)]
            if win == normalize_name(a):
                return a
            if win == normalize_name(b):
                return b
            # recorded draw (penalty winner unknown) → fall through to shootout
        pa, pd, _ = self.pp[(a, b)]
        r = rng.random()
        if r < pa:
            return a
        if r >= pa + pd:
            return b
        wa = 1.0 / (1.0 + 10 ** ((self.elo(b) - self.elo(a)) / 400.0))
        wa = 0.5 + (wa - 0.5) * SHOOTOUT_ELO_WEIGHT
        return a if rng.random() < wa else b


# ── Group stage ──────────────────────────────────────────────────────
def rank_group(teams, pts, gd, played, rng):
    """points → goal difference → head-to-head (among tied) → random."""

    def h2h(team, tied):
        s = 0
        for other in tied:
            if other == team:
                continue
            o = played.get((team, other))
            if o is None:
                o = played.get((other, team))
                s += 3 if o == "B" else (1 if o == "D" else 0)
            else:
                s += 3 if o == "A" else (1 if o == "D" else 0)
        return s

    ordered = sorted(teams, key=lambda t: pts[t], reverse=True)
    result = []
    for _, grp in itertools.groupby(ordered, key=lambda t: pts[t]):
        tied = list(grp)
        if len(tied) > 1:
            tied.sort(key=lambda t: (gd[t], h2h(t, tied), rng.random()), reverse=True)
        result.extend(tied)
    return result


def play_group(teams, ctx, rng):
    pts = {t: 0 for t in teams}
    gd = {t: 0 for t in teams}
    played = {}
    for a, b in itertools.combinations(teams, 2):
        o, gda = ctx.group_match(a, b, rng)
        played[(a, b)] = o
        if o == "A":
            pts[a] += 3
        elif o == "B":
            pts[b] += 3
        else:
            pts[a] += 1
            pts[b] += 1
        gd[a] += gda
        gd[b] -= gda
    return rank_group(teams, pts, gd, played, rng), pts, gd


# ── One conditioned tournament ───────────────────────────────────────
def knockout_round(teams, ctx, rng):
    return [ctx.knockout_winner(teams[i], teams[i + 1], rng) for i in range(0, len(teams), 2)]


def run_one_sim(ctx, rng):
    slot, thirds = {}, []
    for g in GROUP_ORDER:
        ranked, pts, gd = play_group(ctx.groups[g], ctx, rng)
        slot[f"1{g}"], slot[f"2{g}"] = ranked[0], ranked[1]
        if len(ranked) >= 3:
            thirds.append((ranked[2], pts[ranked[2]], gd[ranked[2]]))
    thirds.sort(key=lambda x: (x[1], x[2], rng.random()), reverse=True)
    for i, (team, _, _) in enumerate(thirds[:8]):
        slot[f"T{i + 1}"] = team

    reached = {k: set() for k in STAGES}
    teams = [slot[s] for s in R32_SLOT_ORDER]
    reached["r32"].update(teams)
    for stage in ("r16", "qf", "sf", "final"):
        teams = knockout_round(teams, ctx, rng)
        reached[stage].update(teams)
    reached["win"].add(ctx.knockout_winner(teams[0], teams[1], rng))
    return reached


def simulate(ctx, n, seed):
    rng = random.Random(seed)
    counts = {s: Counter() for s in STAGES}
    for _ in range(n):
        reached = run_one_sim(ctx, rng)
        for s in STAGES:
            counts[s].update(reached[s])
    return counts


# ── Orchestration ────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Live Monte-Carlo of the 2026 World Cup.")
    p.add_argument("--input", type=Path, default=SCRIPT_DIR / ".." / "public" / "team_momentum.json")
    p.add_argument("--output", type=Path, default=SCRIPT_DIR / ".." / "public" / "tournament_sim.json")
    p.add_argument("--results", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--groups", type=Path, default=None, help="Real draw JSON (else scripts/groups.json, else placeholder).")
    p.add_argument("--since", default=WC_SINCE, help="Earliest date counted as this WC edition.")
    p.add_argument("--sims", type=int, default=DEFAULT_SIMS)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    # Model (matchups + Elo).
    if not args.input.exists():
        sys.exit(f"[fatal] {args.input} not found — run compute_momentum.py first.")
    data = json.loads(args.input.read_text(encoding="utf-8"))
    elo_map = {normalize_name(e["team"]): float(e["elo"])
               for e in data.get("teams", [])
               if isinstance(e, dict) and e.get("team") and e.get("elo") is not None}
    matchups = (data.get("model") or {}).get("matchups") or {}

    # Draw.
    groups_path = args.groups or (SCRIPT_DIR / "groups.json")
    if groups_path.exists():
        groups = json.loads(groups_path.read_text(encoding="utf-8"))
        print(f"[groups] loaded real draw from {groups_path.name}")
    else:
        groups = DEFAULT_GROUPS
        print("[groups] ⚠ PLACEHOLDER draw — create scripts/groups.json with the real draw "
              "(names matching team_momentum.json). Odds are fictional until you do.")
    if sorted(groups) != GROUP_ORDER:
        print(f"[groups] ⚠ expected 12 groups A–L; got {sorted(groups)} — bracket slots may misalign.")

    # Reality: lock played matches.
    grp_res, ko_res, n_grp, n_ko, unknown, last_date = load_played_wc(args.results, groups, args.since)
    total_group_matches = sum(len(list(itertools.combinations(ts, 2))) for ts in groups.values())
    print(f"[live] locked {n_grp}/{total_group_matches} group matches + {n_ko} knockout matches "
          f"(since {args.since}).")
    if unknown:
        print(f"[live] ⚠ {len(unknown)} WC team(s) in results.csv not found in the draw "
              f"(name mismatch — fix to lock their games): {', '.join(sorted(unknown)[:10])}")

    ctx = SimContext(groups, elo_map, matchups, grp_res, ko_res)
    wc_teams = ctx.teams
    standings = current_standings(groups, grp_res)
    counts = simulate(ctx, args.sims, args.seed)

    team_group = {t: g for g, ts in groups.items() for t in ts}
    n = float(args.sims)
    rows = []
    for t in wc_teams:
        r32 = counts["r32"][t] / n
        st = standings.get(normalize_name(t), {"played": 0, "points": 0, "gd": 0})
        rows.append({
            "team": t,
            "group": team_group[t],
            "elo": round(ctx.elo(t)),
            "played": st["played"],
            "points": st["points"],
            "gd": st["gd"],
            "status": "eliminated" if r32 <= 0 else ("qualified" if r32 >= 0.999 else "active"),
            "reach_r32": round(r32, 4),
            "reach_r16": round(counts["r16"][t] / n, 4),
            "reach_qf": round(counts["qf"][t] / n, 4),
            "reach_sf": round(counts["sf"][t] / n, 4),
            "reach_final": round(counts["final"][t] / n, 4),
            "win": round(counts["win"][t] / n, 4),
        })
    rows.sort(key=lambda r: r["win"], reverse=True)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": last_date.date().isoformat() if last_date is not None else None,
        "simulations": args.sims,
        "locked": {"group_matches": n_grp, "knockout_matches": n_ko},
        "format": "LIVE · conditions on played results; only unplayed fixtures are simulated",
        "teams": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"✓ Wrote {args.output}")

    elim = sum(1 for r in rows if r["status"] == "eliminated")
    through = sum(1 for r in rows if r["status"] == "qualified")
    print(f"[live] {through} already qualified · {elim} eliminated · {len(rows) - elim - through} still alive.")
    print("\nTop 10 title favourites:")
    print(f"  {'team':<18}{'Win':>7}{'Final':>8}{'R16':>7}  status")
    for r in rows[:10]:
        print(f"  {r['team']:<18}{r['win']*100:>6.1f}%{r['reach_final']*100:>7.1f}%"
              f"{r['reach_r16']*100:>6.1f}%  {r['status']}")


if __name__ == "__main__":
    main()
