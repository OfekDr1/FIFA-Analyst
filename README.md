# ⚽ World Cup 2026 HUD — Live Analytics & ML Prediction Dashboard

A full-stack, self-updating analytics platform for the FIFA World Cup 2026: a
broadcast-style **Next.js dashboard** powered by a **leak-free Python ML
pipeline** that retrains, re-simulates the tournament 10,000 times, and
redeploys itself three times a day while the tournament is being played.

**Frontend:** Next.js 15 · React 19 · Tailwind CSS v4 · Recharts · Lucide · PWA
**Backend:** Python · pandas · scikit-learn · XGBoost · scipy
**Ops:** GitHub Actions (cron) → auto-commit → Vercel

---

## Features

- **Power Rankings** — Elo-surprise momentum leaderboard (over/under-performance
  vs. Elo expectation, recency-weighted)
- **Match Predictions** — hybrid engine: ML 1X2 probabilities + Poisson
  scoreline grid, momentum/Elo badges, live model metrics chip
- **Matchup Analysis** — "Tale of the Tape" deep-dive: animated verdict bar,
  tug-of-war stat comparisons, head-to-head dominance, fire-form indicators
- **Road to the Final** — live Monte-Carlo advancement matrix (R32 → Champion),
  conditioned on real played results: qualified teams badge up, eliminated
  teams fade out, odds sharpen as the tournament unfolds
- **Live Match Tracker** — polling scoreboard with full-screen goal celebration
  overlay (confetti, sound, mute)
- **Accuracy & Calibration** — the model grading itself in public: rolling
  accuracy, Brier score, reliability diagram
- **PWA** — installable, standalone display, mobile-responsive throughout

---

## Architecture

```
eloratings.net      football-data.org        FBref (weekly, manual)
     │                     │                        │
 fetch_elo.py       fetch_api_results.py       fetch_xg.py
     │                     │                        │
     ▼                     ▼                        ▼
elo_ratings.csv       results.csv            team_xg_stats.csv
     └──────────┬──────────┘                        │
                ▼                                   │
        compute_momentum.py  ◄──────────────────────┘
        ├─ compute_elo.py      (point-in-time Elo replay, 1872→today)
        ├─ dixon_coles.py      (goal-model candidate)
        └─ 5-way champion/challenger bake-off
                │
                ▼
     public/team_momentum.json ──► simulate_tournament.py (10k Monte-Carlo runs)
                │                            │
                │                            ▼
                │                 public/tournament_sim.json
                ▼                            │
        Next.js frontend  ◄──────────────────┘
```

Orchestrated by `refresh_data.py` (Elo → results → recompute → simulate),
run on a `0 2,10,18 * * *` cron by `.github/workflows/refresh-data.yml`,
which commits refreshed data → Vercel redeploys automatically.

---

## The Model (and why its numbers are honest)

Predicts 1X2 (win/draw/away) probabilities for every possible matchup from
**14 features, all 100% point-in-time** — a 2016 match is described only by
what was knowable in 2016:

- **In-house Elo replay** (`compute_elo.py`): all 49,000+ internationals since
  1872 replayed with the World Football Elo formula. Validated at **Spearman
  0.984** against eloratings.net — but available *as of any match date*.
- Elo-surprise momentum, rolling goal rates, rest days, goal-difference form,
  head-to-head history, venue advantage, match importance, schedule congestion,
  draw-awareness terms, and interaction features.
- **Wide training window** (2015 →, ~7,500 competitive matches) with
  exponential time-decay sample weights (2-year half-life).

Every refresh runs a **5-way champion/challenger bake-off** on a held-out
recent test set — Logistic Regression, tuned XGBoost, a soft-vote ensemble,
Dixon-Coles (goal model), and a cross-family blend — and ships whichever has
the lowest Brier score. The production model can never silently regress.

**Honest metrics:** Brier ≈ 0.51 · Brier Skill Score ≈ +0.20 vs. climatology
· ~61% accuracy on unseen matches. An earlier build reported 0.44 — that
number was leakage-inflated (current-snapshot features described past
matches) and was retired when the pipeline moved to point-in-time
architecture. The current figure means exactly what it claims.

**Hypotheses tested and closed** (each with a controlled experiment): extra
feature-engineering rounds, exhaustive XGBoost hyperparameter search (400+
fits — confirmed the shipped config), class weighting (rejected: decalibrates),
Dixon-Coles as champion (lost the bake-off; international football shows
almost no low-score correlation, ρ ≈ −0.006).

---

## Quickstart

### Frontend
```bash
npm install
npm run dev          # http://localhost:3000
```

### Backend pipeline
```bash
pip install -r scripts/requirements.txt      # Windows: py -m pip install ...
cd scripts
python refresh_data.py                       # Windows: py refresh_data.py
```
This fetches Elo + results, rebuilds `public/team_momentum.json` (momentum,
Elo, xG, ML matchup table), and re-simulates the tournament into
`public/tournament_sim.json`.

### Secrets
Create `scripts/.env` (git-ignored):
```
FOOTBALL_DATA_API_KEY=your_key_from_football-data.org
```
For CI, add the same key as a GitHub Actions repository secret
(plus optionally `VERCEL_DEPLOY_HOOK_URL`), and enable *read & write*
workflow permissions.

---

## Scripts Reference

| Script | Purpose | Cadence |
|---|---|---|
| `refresh_data.py` | Orchestrator: Elo → results → recompute → simulate | 3×/day (CI) |
| `compute_momentum.py` | Team stats + trains the ML model + exports the JSON | via orchestrator |
| `compute_elo.py` | Point-in-time Elo replay of the full match history | imported / standalone sanity check |
| `simulate_tournament.py` | 10k-run live Monte-Carlo, conditioned on played results | via orchestrator |
| `fetch_elo.py` | Scrapes eloratings.net with anti-corruption audit guards | via orchestrator |
| `fetch_api_results.py` | Pulls finished matches from football-data.org, de-duplicates | via orchestrator |
| `fetch_xg.py` | Tiered real xG: FBref/Opta where covered → real goals-per-90 | **weekly, manual** (FBref rate-limits scrapers — keep out of CI) |
| `dixon_coles.py` | Dixon-Coles goal model (bake-off candidate) | imported / standalone self-test |
| `evaluate_model.py` | Diagnostics: confusion matrices, reliability diagram, BSS, feature importance | on demand |
| `tune_xgboost.py` | RandomizedSearchCV over XGBoost (multiclass-Brier scorer, temporal CV) | on demand |
| `add_result.py` | Manually log one result + trigger recompute | on demand |

**Maintained data:** `scripts/groups.json` — the official 2026 group draw
(ground truth for the simulator; team names must match `results.csv`).

---

## Data Sources & Credits

- Historical results: the international football results dataset (1872–present)
- Elo ratings: [eloratings.net](https://www.eloratings.net) (snapshot cross-check; point-in-time ratings computed in-house)
- Live results: [football-data.org](https://www.football-data.org) (free tier)
- xG: FBref/Opta via [soccerdata](https://github.com/probberechts/soccerdata), with a real goals-per-90 fallback
- Flags: [flagcdn.com](https://flagcdn.com)

> Fair-use note: `fetch_xg.py` is deliberately excluded from CI automation out
> of respect for FBref's scraping limits.

---

## Design Principles

1. **No fabricated inputs.** Every number traces to a real source or a real
   calculation; ingest scripts audit themselves and refuse silent corruption.
2. **No leakage.** Features are point-in-time; splits are chronological;
   evaluation is on genuinely unseen matches.
3. **Never ship a regression.** Champion/challenger selection guards every
   deploy.
4. **Degrade gracefully.** Any feed can fail; the pipeline continues on the
   freshest data it has, and the UI renders honest fallbacks.
