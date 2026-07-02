"""
compute_momentum.py
===================

Calculate a "Team Momentum Score" for international football teams from a
results CSV and export a frontend-friendly JSON file.

Expected CSV columns:
    date, home_team, away_team, home_score, away_score,
    tournament, city, country, neutral

Usage:
    pip install pandas
    python compute_momentum.py
    python compute_momentum.py --input results.csv --output public/team_momentum.json
    python compute_momentum.py --since 2024-06-01 --min-matches 3
"""

from __future__ import annotations

import argparse
import json
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


# ── Tunable constants ────────────────────────────────────────────────
DEFAULT_SINCE = "2024-06-01"   # "last 24 months" → June 2024 onwards
DEFAULT_MIN_MATCHES = 5        # stricter: weed out tiny-sample outliers
DEFAULT_ELO = 1500             # baseline when a team has no Elo rating
DEFAULT_XG = 1.10              # tournament-baseline xG / xGA per 90 (missing teams)

# Quality-weighted momentum (Elo-surprise)
QM_RECENT = 10                 # consider each team's last N matches
QM_DECAY = 0.85                # recency decay (most recent weighted ~1)

# Rolling-form features
GD_WINDOW = 5                  # rolling goal-difference window (matches)
REST_DEFAULT = 14              # imputed rest days for a team's first match

# Head-to-head + match-context features
H2H_WINDOW = 5                 # last N meetings between the two teams
WC_IMPORTANCE = 3.0            # match_importance for the World Cup (deployment)

# Interaction / edge-case features
FATIGUE_WINDOW = 30            # rolling window (days) for schedule congestion
UNDERDOG_GAP = 100             # Elo deficit that flags a home-hosting underdog

# Wide-window ML training (point-in-time replay Elo — see compute_elo.py)
DEFAULT_TRAIN_SINCE = "2015-01-01"  # ML window; earlier history is warm-up only
HALF_LIFE_DAYS = 730                # sample-weight half-life (~2 years)
RATE_WINDOW = 15                    # rolling goals-for/against window (matches)
DEFAULT_RATE = 1.30                 # goals/90 prior for teams with no history


def normalize_name(name: str) -> str:
    """Lowercase + strip accents/whitespace for a forgiving name join."""
    if not isinstance(name, str):
        return ""
    text = unicodedata.normalize("NFKD", name)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.strip().lower()


# ── 1. Load & filter ─────────────────────────────────────────────────
def load_and_filter(path: Path, since: str) -> pd.DataFrame:
    """Read the CSV, keep competitive matches from `since` onwards."""
    df = pd.read_csv(path)

    # Parse dates; drop anything unparseable.
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"])

    # Requirement 1 — only the recent window (last ~24 months).
    df = df[df["date"] >= pd.Timestamp(since)]

    # Requirement 2 — drop friendlies (case-insensitive, whitespace-safe).
    tournament = df["tournament"].fillna("").str.strip().str.lower()
    df = df[tournament != "friendly"]

    # Scores must be present and numeric to grade a result.
    df = df.dropna(subset=["home_score", "away_score"])
    df["home_score"] = df["home_score"].astype(int)
    df["away_score"] = df["away_score"].astype(int)

    return df.reset_index(drop=True)


# ── 2. Reshape to one row per (team, match) ──────────────────────────
def to_team_perspective(df: pd.DataFrame) -> pd.DataFrame:
    """
    Explode each match into two rows — one per team — so a single
    groupby covers both home and away appearances.

    Each row carries goals_for / goals_against / points from that
    team's point of view.
    """

    def side(team_col: str, gf_col: str, ga_col: str) -> pd.DataFrame:
        out = pd.DataFrame({
            "team": df[team_col],
            "goals_for": df[gf_col],
            "goals_against": df[ga_col],
        })
        # Points: win = 3, draw = 1, loss = 0
        out["points"] = np.where(
            out["goals_for"] > out["goals_against"], 3,
            np.where(out["goals_for"] == out["goals_against"], 1, 0),
        )
        out["win"] = (out["goals_for"] > out["goals_against"]).astype(int)
        out["draw"] = (out["goals_for"] == out["goals_against"]).astype(int)
        out["loss"] = (out["goals_for"] < out["goals_against"]).astype(int)
        return out

    home = side("home_team", "home_score", "away_score")
    away = side("away_team", "away_score", "home_score")
    return pd.concat([home, away], ignore_index=True)


# ── 3. Aggregate per-team features ───────────────────────────────────
def aggregate(team_rows: pd.DataFrame, min_matches: int) -> pd.DataFrame:
    g = team_rows.groupby("team", as_index=False).agg(
        matches_played=("points", "size"),
        points=("points", "sum"),
        wins=("win", "sum"),
        draws=("draw", "sum"),
        losses=("loss", "sum"),
        avg_goals_scored=("goals_for", "mean"),
        avg_goals_conceded=("goals_against", "mean"),
    )

    # Drop teams with too few competitive matches to be meaningful.
    g = g[g["matches_played"] >= min_matches].copy()

    g["win_rate"] = (g["wins"] / g["matches_played"]) * 100.0
    g["avg_goal_difference"] = g["avg_goals_scored"] - g["avg_goals_conceded"]
    return g


# ── 4. Quality-weighted momentum + rolling form ──────────────────────
def attach_quality_momentum(team_stats: pd.DataFrame, matches: pd.DataFrame) -> pd.DataFrame:
    """
    Replace naive win-rate momentum with an Elo-SURPRISE score: how much a
    team over/under-performs its Elo expectation, recency-weighted over its
    last QM_RECENT matches. Beating a much stronger side (low expectation)
    spikes it; beating a 1500-Elo minnow barely moves it.

    momentum_score ∈ [0, 100], where 50 = performing exactly to Elo.
    """
    elo_by = {
        normalize_name(t): float(e)
        for t, e in zip(team_stats["team"], team_stats["elo"])
    }

    def elo_of(name: str) -> float:
        return elo_by.get(normalize_name(name), float(DEFAULT_ELO))

    perf: dict[str, list[tuple]] = {}
    for _, m in matches.iterrows():
        h, a = m["home_team"], m["away_team"]
        eh, ea = elo_of(h), elo_of(a)
        exp_h = 1.0 / (1.0 + 10 ** ((ea - eh) / 400.0))  # Elo-expected score
        res_h = (
            1.0 if m["home_score"] > m["away_score"]
            else 0.5 if m["home_score"] == m["away_score"]
            else 0.0
        )
        # Performance vs expectation is zero-sum: away = −home.
        perf.setdefault(normalize_name(h), []).append((m["date"], res_h - exp_h))
        perf.setdefault(normalize_name(a), []).append((m["date"], (1 - res_h) - (1 - exp_h)))

    scores: dict[str, float] = {}
    for key, plist in perf.items():
        plist.sort(key=lambda x: x[0])                 # oldest → newest
        recent = plist[-QM_RECENT:]
        n = len(recent)
        num = sum(pv * (QM_DECAY ** (n - 1 - i)) for i, (_, pv) in enumerate(recent))
        den = sum(QM_DECAY ** (n - 1 - i) for i in range(n))
        avg = num / den if den else 0.0                # in [-1, 1]
        scores[key] = round((avg + 1.0) / 2.0 * 100.0, 1)

    ts = team_stats.copy()
    ts["momentum_score"] = ts["team"].map(lambda t: scores.get(normalize_name(t), 50.0))
    return ts


def attach_gd_form(team_stats: pd.DataFrame, matches: pd.DataFrame) -> pd.DataFrame:
    """Each team's rolling goal difference over its most recent GD_WINDOW
    matches (a current-form signal). Defaults to 0 for teams with no games."""
    hist: dict[str, list[int]] = {}
    for _, m in matches.sort_values("date").iterrows():
        diff = int(m["home_score"] - m["away_score"])
        hist.setdefault(normalize_name(m["home_team"]), []).append(diff)
        hist.setdefault(normalize_name(m["away_team"]), []).append(-diff)
    form = {k: float(sum(v[-GD_WINDOW:])) for k, v in hist.items()}

    ts = team_stats.copy()
    ts["gd_form"] = ts["team"].map(lambda t: form.get(normalize_name(t), 0.0))
    return ts


def add_momentum(g: pd.DataFrame) -> pd.DataFrame:
    """Sort by the (already-computed) momentum_score and assign ranks."""
    g = g.sort_values("momentum_score", ascending=False).reset_index(drop=True)
    g["rank"] = g.index + 1
    return g


# ── Elo ratings (World Football Elo) ─────────────────────────────────
def load_elo(path: Path) -> pd.DataFrame:
    """
    Load the historical Elo CSV (columns: country, rating, snapshot_date)
    and reduce it to the single most-recent rating per country.

    Returns a frame with columns [team, elo]. An absent file yields an
    empty frame, so the pipeline still runs (all teams → DEFAULT_ELO).
    """
    if not path.exists():
        print(f"[elo] {path} not found — defaulting every team to {DEFAULT_ELO}.")
        return pd.DataFrame(columns=["team", "elo"])

    # 1. Read with the real column names.
    raw = pd.read_csv(path, usecols=["country", "rating", "snapshot_date"])

    # 2. Rename to our schema.
    elo = raw.rename(columns={"country": "team", "rating": "elo"})
    elo["snapshot_date"] = pd.to_datetime(elo["snapshot_date"], errors="coerce")
    elo["elo"] = pd.to_numeric(elo["elo"], errors="coerce")

    # 3. Newest first, then keep one row per team = its latest rating.
    elo = (
        elo.dropna(subset=["team"])
        .sort_values("snapshot_date", ascending=False)
        .drop_duplicates(subset="team", keep="first")
    )
    return elo[["team", "elo"]]


def attach_elo(team_stats: pd.DataFrame, elo: pd.DataFrame) -> pd.DataFrame:
    """
    Left-join Elo onto the team-stats frame by team name. Names are
    normalized for matching, but the canonical team name is preserved.
    Teams without an Elo rating fall back to DEFAULT_ELO (1500).
    """
    ts = team_stats.copy()
    ts["_key"] = ts["team"].map(normalize_name)

    if not elo.empty:
        el = elo.copy()
        el["_key"] = el["team"].map(normalize_name)
        el = el[["_key", "elo"]].dropna(subset=["_key"]).drop_duplicates("_key")
        ts = ts.merge(el, on="_key", how="left")  # LEFT JOIN
    else:
        ts["elo"] = np.nan

    ts = ts.drop(columns="_key")
    ts["elo"] = ts["elo"].fillna(DEFAULT_ELO).round().astype(int)
    return ts


# ── Expected Goals (underlying quality) ──────────────────────────────
def load_xg(path: Path) -> pd.DataFrame:
    """
    Load `team_xg_stats.csv` (columns: team, xG_per_90, xGA_per_90).
    Returns an empty frame if absent so the pipeline still runs (all
    teams → DEFAULT_XG).
    """
    if not path.exists():
        print(f"[xg] {path} not found — defaulting xG/xGA to {DEFAULT_XG}.")
        return pd.DataFrame(columns=["team", "xG_per_90", "xGA_per_90"])

    xg = pd.read_csv(path, usecols=["team", "xG_per_90", "xGA_per_90"]).copy()
    xg["xG_per_90"] = pd.to_numeric(xg["xG_per_90"], errors="coerce")
    xg["xGA_per_90"] = pd.to_numeric(xg["xGA_per_90"], errors="coerce")
    return xg.dropna(subset=["team"])


def attach_xg(team_stats: pd.DataFrame, xg: pd.DataFrame) -> pd.DataFrame:
    """
    Left-join xG/xGA onto the team-stats frame by (normalized) team name.
    Teams missing from the CSV fall back to DEFAULT_XG (1.10) for both.
    """
    ts = team_stats.copy()
    ts["_key"] = ts["team"].map(normalize_name)

    if not xg.empty:
        x = xg.copy()
        x["_key"] = x["team"].map(normalize_name)
        x = (
            x[["_key", "xG_per_90", "xGA_per_90"]]
            .dropna(subset=["_key"])
            .drop_duplicates("_key")
        )
        ts = ts.merge(x, on="_key", how="left")  # LEFT JOIN
    else:
        ts["xG_per_90"] = np.nan
        ts["xGA_per_90"] = np.nan

    ts = ts.drop(columns="_key")
    ts["xG_per_90"] = ts["xG_per_90"].fillna(DEFAULT_XG).round(2)
    ts["xGA_per_90"] = ts["xGA_per_90"].fillna(DEFAULT_XG).round(2)
    return ts


# ── 5. Tidy + export ─────────────────────────────────────────────────
def round_columns(g: pd.DataFrame) -> pd.DataFrame:
    rounding = {
        "win_rate": 1,
        "avg_goals_scored": 2,
        "avg_goals_conceded": 2,
        "avg_goal_difference": 2,
        "momentum_score": 1,
        "gd_form": 1,
    }
    for col, places in rounding.items():
        if col in g.columns:
            g[col] = g[col].round(places)
    return g


def export_json(
    g: pd.DataFrame, output: Path, since: str, model: dict | None = None
) -> None:
    # to_json → json.loads converts numpy types to native Python types cleanly.
    teams = json.loads(g.to_json(orient="records"))

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window": {"from": since, "to": str(g.attrs.get("max_date", ""))},
        "filters": {
            "exclude_tournaments": ["Friendly"],
            "min_matches": DEFAULT_MIN_MATCHES,
            "elo_baseline": DEFAULT_ELO,
            "xg_baseline": DEFAULT_XG,
        },
        "momentum": {"method": "elo_surprise", "recent": QM_RECENT, "decay": QM_DECAY},
        "count": len(teams),
        "teams": teams,
        # Learned 1X2 model (coefficients) for the TS engine — Option A.
        "model": model,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


# ── ML model: learn optimal 1X2 weights & minimise Brier ─────────────
ML_FEATURES = [
    # ALL 100% point-in-time — replayed Elo + rolling state AS OF each kickoff
    # (a 2016 match is described by 2016 values, never today's).
    "elo_diff", "momentum_diff", "gf90_diff", "ga90_diff", "rest_diff", "gd_form_diff",
    # Draw-awareness: |elo gap| encodes "evenness"; total scoring rate captures
    # low-scoring (draw-prone) games.
    "abs_elo_diff", "total_gf90",
    # Interaction-rich tree-food: venue, match stakes, head-to-head history.
    "is_home_advantage", "match_importance", "h2h_gd",
    # Non-linear interactions & edge cases the trees can branch on:
    # multiplicative attack×defence clash, schedule congestion, host-underdog.
    "attack_vs_defense", "fatigue_accumulation", "is_home_underdog",
]


def _is_neutral_venue(val: object) -> bool:
    return str(val).strip().lower() in ("true", "1", "yes", "t")


def home_advantage(row) -> float:
    """+1 if the home team actually hosts, -1 if the listed away team hosts,
    0 on neutral ground. Uses the `neutral` flag, refined by `country`."""
    if _is_neutral_venue(row.get("neutral", "")):
        return 0.0
    country = normalize_name(str(row.get("country", "")))
    if country:
        if country == normalize_name(row["home_team"]):
            return 1.0
        if country == normalize_name(row["away_team"]):
            return -1.0
    return 1.0  # not neutral, country unknown → assume nominal home team hosts


def match_importance(tournament: object) -> float:
    """Graded stakes (friendlies are filtered upstream, so this varies 1/2/3):
    qualifiers = 2, continental / World-Cup finals = 3, else 1."""
    t = str(tournament).lower()
    if "friendly" in t:
        return 0.0
    if "qualif" in t:                      # checked first ("world cup qualification")
        return 2.0
    finals = ("world cup", "euro", "copa am", "copa américa",
              "africa cup", "afcon", "asian cup", "gold cup")
    if any(k in t for k in finals):
        return 3.0
    return 1.0                             # Nations League & other competitive


def h2h_gd_table(matches: pd.DataFrame) -> dict:
    """Final head-to-head average goal difference (last H2H_WINDOW meetings) per
    canonical team pair, from the alphabetically-first team's view — for the
    deployment pre-compute."""
    hist: dict[tuple, list[int]] = {}
    for _, m in matches.sort_values("date").iterrows():
        lo, hi = sorted([normalize_name(m["home_team"]), normalize_name(m["away_team"])])
        gd = m["home_score"] - m["away_score"]
        hist.setdefault((lo, hi), []).append(int(gd if normalize_name(m["home_team"]) == lo else -gd))
    return {pair: float(np.mean(v[-H2H_WINDOW:])) for pair, v in hist.items()}


def h2h_for(table: dict, home: str, away: str) -> float:
    """Look up the head-to-head GD oriented to `home`'s view (0 if no history)."""
    lo, hi = sorted([normalize_name(home), normalize_name(away)])
    avg_lo = table.get((lo, hi))
    if avg_lo is None:
        return 0.0
    return avg_lo if normalize_name(home) == lo else -avg_lo


def build_match_features(matches: pd.DataFrame, train_since: str = DEFAULT_TRAIN_SINCE):
    """
    Chronological, 100%-point-in-time feature frame. `matches` must carry the
    replay columns elo_h_pre / elo_a_pre (compute_elo.attach_replay_elo) — every
    feature describes the match AS OF kickoff, never with today's values.

    State (Elo-surprise momentum, rolling goal rates, rest, GD form, H2H,
    congestion) accumulates over ALL rows, but feature rows are only emitted
    from `train_since` onwards — earlier history is pure warm-up. Shared by
    compute_momentum / evaluate_model / tune_xgboost so they can never drift.

    Returns (frame, deploy_state): deploy_state carries each team's
    end-of-history momentum / gf90 / ga90 / gd_form for the pre-compute, so
    training and deployment use identical feature definitions.
    """
    since_ts = pd.Timestamp(train_since)
    last_played: dict[str, object] = {}
    gd_hist: dict[str, list[int]] = {}
    h2h_hist: dict[tuple, list[int]] = {}
    played_dates: dict[str, list] = {}
    perf_hist: dict[str, list[float]] = {}            # Elo-surprise → momentum
    rate_hist: dict[str, list[tuple[int, int]]] = {}  # (gf, ga) → rolling rates
    rows = []

    def momentum_of(key: str) -> float:
        """Point-in-time Elo-surprise momentum (same formula as the UI metric)."""
        recent = perf_hist.get(key, [])[-QM_RECENT:]
        if not recent:
            return 50.0
        n = len(recent)
        num = sum(p * (QM_DECAY ** (n - 1 - i)) for i, p in enumerate(recent))
        den = sum(QM_DECAY ** (n - 1 - i) for i in range(n))
        return ((num / den) + 1.0) / 2.0 * 100.0

    def rates_of(key: str) -> tuple[float, float]:
        """Rolling real goals for/against per 90 over the last RATE_WINDOW."""
        recent = rate_hist.get(key, [])[-RATE_WINDOW:]
        if not recent:
            return DEFAULT_RATE, DEFAULT_RATE
        return (sum(gf for gf, _ in recent) / len(recent),
                sum(ga for _, ga in recent) / len(recent))

    for _, m in matches.sort_values("date").iterrows():
        h, a, d = m["home_team"], m["away_team"], m["date"]
        nh, na = normalize_name(h), normalize_name(a)
        hs, as_ = int(m["home_score"]), int(m["away_score"])
        eh, ea = float(m["elo_h_pre"]), float(m["elo_a_pre"])
        lo, hi = sorted([nh, na])

        if d >= since_ts:
            yv = "H" if hs > as_ else ("A" if hs < as_ else "D")
            rest_h = (d - last_played[nh]).days if nh in last_played else REST_DEFAULT
            rest_a = (d - last_played[na]).days if na in last_played else REST_DEFAULT
            gd_h = float(sum(gd_hist.get(nh, [])[-GD_WINDOW:]))
            gd_a = float(sum(gd_hist.get(na, [])[-GD_WINDOW:]))
            cong_h = sum(1 for pdt in played_dates.get(nh, []) if (d - pdt).days <= FATIGUE_WINDOW)
            cong_a = sum(1 for pdt in played_dates.get(na, []) if (d - pdt).days <= FATIGUE_WINDOW)

            past = h2h_hist.get((lo, hi), [])[-H2H_WINDOW:]
            if past:
                avg_lo = sum(past) / len(past)
                h2h = avg_lo if nh == lo else -avg_lo
            else:
                h2h = 0.0

            gfh, gah = rates_of(nh)
            gfa, gaa = rates_of(na)
            home_adv = home_advantage(m)

            rows.append({
                "date": d,
                # Metadata passthrough (NOT features) — lets scoreline models
                # like Dixon-Coles train on the exact same rows/split.
                "home_team": h, "away_team": a,
                "home_score": hs, "away_score": as_,
                "elo_diff": eh - ea,
                "momentum_diff": momentum_of(nh) - momentum_of(na),
                "gf90_diff": gfh - gfa,
                "ga90_diff": gah - gaa,
                "rest_diff": float(rest_h - rest_a),
                "gd_form_diff": gd_h - gd_a,
                "abs_elo_diff": abs(eh - ea),
                "total_gf90": gfh + gfa,
                "is_home_advantage": home_adv,
                "match_importance": match_importance(m.get("tournament", "")),
                "h2h_gd": h2h,
                # Non-linear interactions ↓
                "attack_vs_defense": gfh * gaa - gfa * gah,       # multiplicative clash
                "fatigue_accumulation": float(cong_h - cong_a),   # 30-day congestion gap
                "is_home_underdog": 1.0 if (home_adv == 1.0 and eh <= ea - UNDERDOG_GAP) else 0.0,
                "y": yv,
            })

        # ── State updates (always — warm-up rows feed the state too) ──
        exp_h = 1.0 / (1.0 + 10 ** ((ea - eh) / 400.0))
        res_h = 1.0 if hs > as_ else 0.5 if hs == as_ else 0.0
        perf_hist.setdefault(nh, []).append(res_h - exp_h)
        perf_hist.setdefault(na, []).append((1 - res_h) - (1 - exp_h))
        rate_hist.setdefault(nh, []).append((hs, as_))
        rate_hist.setdefault(na, []).append((as_, hs))
        last_played[nh] = d
        last_played[na] = d
        gd_hist.setdefault(nh, []).append(int(hs - as_))
        gd_hist.setdefault(na, []).append(int(as_ - hs))
        h2h_hist.setdefault((lo, hi), []).append(int((hs - as_) if nh == lo else (as_ - hs)))
        played_dates.setdefault(nh, []).append(d)
        played_dates.setdefault(na, []).append(d)

    state = {
        "momentum": {k: momentum_of(k) for k in perf_hist},
        "gf90": {k: rates_of(k)[0] for k in rate_hist},
        "ga90": {k: rates_of(k)[1] for k in rate_hist},
        "gd_form": {k: float(sum(v[-GD_WINDOW:])) for k, v in gd_hist.items()},
    }
    frame = pd.DataFrame(rows).dropna(subset=ML_FEATURES + ["y"]).sort_values("date")
    return frame, state


def prepare_training_data(input_path: Path, train_since: str = DEFAULT_TRAIN_SINCE):
    """
    Full-history ML data pipeline: read ALL of results.csv, replay point-in-time
    Elo across every match (friendlies included — they move ratings, at low K),
    then build the point-in-time feature frame over COMPETITIVE matches only,
    emitting rows from `train_since` (state warms up on everything earlier).

    Returns (features_df, deploy_state, competitive_df); deploy_state includes
    "elo" — the replay's end-of-history ratings.
    """
    from compute_elo import attach_replay_elo, load_history

    df = load_history(input_path)
    df, final_elo = attach_replay_elo(df)
    tourn = df["tournament"].fillna("").str.strip().str.lower()
    comp = df[tourn != "friendly"].reset_index(drop=True)
    feats, state = build_match_features(comp, train_since=train_since)
    state["elo"] = final_elo
    return feats, state, comp


def fit_weighted(model, X, y, sample_weight=None):
    """Fit any candidate with optional sample weights, routing them correctly:
    sklearn Pipelines need step-prefixed kwargs; bare estimators (XGBoost) and
    SoftVote take sample_weight directly."""
    if sample_weight is None:
        model.fit(X, y)
    elif hasattr(model, "steps"):  # sklearn Pipeline → route to the final step
        model.fit(X, y, **{f"{model.steps[-1][0]}__sample_weight": sample_weight})
    else:
        model.fit(X, y, sample_weight=sample_weight)
    return model


class SoftVote:
    """Equal-weight probability average of member models. Replaces sklearn's
    VotingClassifier, which cannot route sample_weight into Pipeline members."""

    def __init__(self, builders):
        self.builders = builders

    def fit(self, X, y, sample_weight=None):
        self.models_ = [fit_weighted(b(), X, y, sample_weight) for b in self.builders]
        self.classes_ = self.models_[0].classes_
        return self

    def predict_proba(self, X):
        # float64 + renormalise: XGBoost emits float32 rows that miss 1.0 by
        # ~1e-7, which trips sklearn's probability checks downstream.
        p = np.mean([np.asarray(m.predict_proba(X), dtype=float) for m in self.models_], axis=0)
        return p / p.sum(axis=1, keepdims=True)

    def predict(self, X):
        return self.classes_[np.argmax(self.predict_proba(X), axis=1)]


def train_prediction_model(input_path: Path, team_stats: pd.DataFrame,
                           train_since: str = DEFAULT_TRAIN_SINCE,
                           half_life_days: float = HALF_LIFE_DAYS):
    """
    Predict 1X2 outcomes from 100%-point-in-time features (replayed Elo,
    Elo-surprise momentum, rolling goal rates, form/rest/H2H/context) over a
    WIDE training window (train_since →) with time-decay sample weights — a
    decade of history stabilises the fit while recent matches dominate it.

    Trains THREE candidates — tuned XGBoost, Logistic Regression, and their
    soft-vote blend — scores all on a held-out recent-era test set (the most
    recent 20% of the last-24-months window, so Brier stays comparable across
    pipeline versions), and PRE-COMPUTES every matchup from the champion:
        { "home|away": [pHome, pDraw, pAway] }
    Returns None if xgboost/scikit-learn or data are unavailable.
    """
    try:
        from xgboost import XGBClassifier
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import make_pipeline
        from sklearn.metrics import accuracy_score, log_loss
    except ImportError:
        print("[ml] xgboost/scikit-learn missing — skipping. "
              "`pip install xgboost scikit-learn`")
        return None

    # Full-history point-in-time frame (shared with evaluate/tune — no drift).
    data, state, comp = prepare_training_data(input_path, train_since)
    if len(data) < 200:
        print(f"[ml] Only {len(data)} usable matches — too few to train; skipping.")
        return None

    X = data[ML_FEATURES].to_numpy(dtype=float)

    # Integer classes 0..K-1.  Home win=0, Draw=1, Away win=2.
    y = data["y"].map({"H": 0, "D": 1, "A": 2}).to_numpy()

    # Test = most recent 20% of the modern era (last 24 months) — the same
    # matches earlier pipeline versions tested on, so Brier stays comparable.
    n_recent = int((data["date"] >= pd.Timestamp(DEFAULT_SINCE)).sum())
    test_n = max(50, int(n_recent * 0.2))
    split = len(data) - test_n
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]

    # Time-decay sample weights (half-life ≈ 2y): recent evidence dominates the
    # fit; deep history regularises it. Test metrics stay unweighted.
    age_days = (data["date"].max() - data["date"]).dt.days.to_numpy(dtype=float)
    w = 0.5 ** (age_days / float(half_life_days))
    w_tr = w[:split]
    print(f"[ml] train {split} matches ({data['date'].iloc[0].date()} → "
          f"{data['date'].iloc[split - 1].date()}, decay half-life {half_life_days:.0f}d) "
          f"· test {test_n} most-recent")

    # Reorder any model's predict_proba into fixed [Home(0), Draw(1), Away(2)]
    # column order, using its own classes_ — this is the airtight guard
    # against any Home/Away mix-up regardless of class ordering.
    def to_hda(model, proba: np.ndarray) -> np.ndarray:
        col = {int(c): i for i, c in enumerate(model.classes_)}
        n = len(proba)
        return np.column_stack([
            proba[:, col[0]] if 0 in col else np.zeros(n),
            proba[:, col[1]] if 1 in col else np.zeros(n),
            proba[:, col[2]] if 2 in col else np.zeros(n),
        ])

    def brier_of(proba_hda: np.ndarray, y_true: np.ndarray) -> float:
        onehot = np.zeros((len(y_true), 3))
        for i, c in enumerate(y_true):
            onehot[i, int(c)] = 1.0
        return float(np.mean(np.sum((proba_hda - onehot) ** 2, axis=1)))

    # 3 — Tuned XGBoost: regularised (slow LR, strong subsampling + L1/L2 +
    #     min_child_weight + gamma) for noisy data. Params from tune_xgboost.py
    #     (RandomizedSearchCV optimising multiclass Brier).
    def build_xgb():
        return XGBClassifier(
            n_estimators=430,
            learning_rate=0.02037,
            max_depth=4,
            min_child_weight=11,
            subsample=0.83391,
            colsample_bytree=0.84832,
            gamma=1.73707,
            reg_alpha=0.14095,
            reg_lambda=1.14485,
            eval_metric="mlogloss",
            tree_method="hist",
            random_state=42,
            n_jobs=2,
        )

    def build_lr():
        return make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=1000, C=1.0)
        )

    def build_ensemble():
        # Soft-vote: average LR's well-calibrated probs with XGB's sharper
        # ones. Equal weights — no test-set weight search, so it stays
        # leakage-free. (Custom SoftVote: sklearn's VotingClassifier can't
        # route sample_weight into Pipeline members.)
        return SoftVote([build_lr, build_xgb])

    candidates = {
        "xgboost": build_xgb,
        "logistic_regression": build_lr,
        "ensemble": build_ensemble,
    }
    scored, probas = {}, {}
    for tag, build in candidates.items():
        clf = fit_weighted(build(), X_tr, y_tr, w_tr)
        probas[tag] = to_hda(clf, clf.predict_proba(X_te))
        scored[tag] = brier_of(probas[tag], y_te)

    # ── Dixon-Coles goal model: trained on SCORELINES, not 1X2 labels — it
    #    recovers the signal classifiers throw away (a 5-0 ≠ a 1-0) and prices
    #    draws natively from the score grid. Trains on ALL matches INCLUDING
    #    friendlies (at half weight): confederations rarely meet competitively,
    #    so friendlies are the cross-conference glue that anchors CONMEBOL vs
    #    UEFA etc. Strictly pre-test-date rows only — leak-free.
    from compute_elo import load_history
    from dixon_coles import DixonColes

    META = ["home_team", "away_team", "home_score", "away_score", "is_home_advantage"]
    rows_all = data[META]
    full = load_history(input_path)
    full_rows = pd.DataFrame({
        "home_team": full["home_team"], "away_team": full["away_team"],
        "home_score": full["home_score"], "away_score": full["away_score"],
        "is_home_advantage": full.apply(home_advantage, axis=1),
        "date": full["date"],
        "friendly": full["tournament"].fillna("").str.strip().str.lower().eq("friendly"),
    })
    w_full = (0.5 ** ((full_rows["date"].max() - full_rows["date"]).dt.days.to_numpy(dtype=float)
                      / float(half_life_days))
              * np.where(full_rows["friendly"], 0.5, 1.0))
    test_start = data["date"].iloc[split]
    pre_test = (full_rows["date"] < test_start).to_numpy()

    dc = DixonColes().fit(full_rows[pre_test], sample_weight=w_full[pre_test])
    probas["dixon_coles"] = dc.predict_rows(rows_all.iloc[split:])
    scored["dixon_coles"] = brier_of(probas["dixon_coles"], y_te)
    print(f"[dc] home_adv {dc.home_adv_:+.3f} · rho {dc.rho_:+.4f} · {len(dc.teams_)} teams")

    # Cross-family blend: feature-ensemble × goal-model, equal weights (no
    # test-set weight search → leakage-free).
    probas["dc_blend"] = 0.5 * (probas["ensemble"] + probas["dixon_coles"])
    scored["dc_blend"] = brier_of(probas["dc_blend"], y_te)

    # No-skill baseline (predict train class frequencies for everything).
    freq = pd.Series(y_tr).value_counts(normalize=True)
    base = np.tile([freq.get(0, 0.0), freq.get(1, 0.0), freq.get(2, 0.0)], (len(y_te), 1))
    base_brier = brier_of(base, y_te)

    # Champion = lowest test Brier (probas were retained for every candidate,
    # so mixed families — classifiers, DC, blends — compete on equal footing).
    champ_tag = min(scored, key=scored.get)
    champ_proba = probas[champ_tag]
    champ_brier = scored[champ_tag]
    champ_acc = float(accuracy_score(y_te, champ_proba.argmax(axis=1)))
    champ_ll = float(log_loss(y_te, champ_proba, labels=[0, 1, 2]))

    print("\n── ML 1X2 model selection (held-out Brier) ──")
    for tag, b in sorted(scored.items(), key=lambda kv: kv[1]):
        mark = " ← champion" if tag == champ_tag else ""
        print(f"  {tag:<22} Brier {b:.3f}{mark}")
    print(f"  {'baseline (no-skill)':<22} Brier {base_brier:.3f}")
    print(f"  Champion accuracy {champ_acc:.3f} · log-loss {champ_ll:.3f}")

    # ── Refit the champion FAMILY on ALL data (weighted), pre-compute ──
    h2h_table = h2h_gd_table(comp)

    # Deployment features come from the SAME point-in-time state the training
    # rows were built from, at end-of-history — train/deploy cannot diverge.
    def sv(dic: dict, team: str, default: float) -> float:
        return float(dic.get(normalize_name(team), default))

    teams_list = list(team_stats["team"])
    tf = {
        t: (
            sv(state["elo"], t, DEFAULT_ELO),
            sv(state["momentum"], t, 50.0),
            sv(state["gf90"], t, DEFAULT_RATE),
            sv(state["ga90"], t, DEFAULT_RATE),
            sv(state["gd_form"], t, 0.0),
        )
        for t in teams_list
    }

    # Feature order must match ML_FEATURES. At deployment there's no fixture
    # date, so rest_diff = 0 (equal-rest assumption).
    keys, feat_rows, pairs = [], [], []
    for home in teams_list:
        for away in teams_list:
            if home == away:
                continue
            pairs.append((home, away))
            eh, mh, xh, xah, fh = tf[home]
            ea, ma, xa, xaa, fa = tf[away]
            # Order MUST match ML_FEATURES. Deployment is World Cup context:
            # neutral venue → is_home_advantage = 0 (so is_home_underdog = 0),
            # rest_diff = 0, no schedule → fatigue = 0. The attack×defence
            # clash is matchup-specific and still differentiates.
            feat_rows.append([
                eh - ea, mh - ma, xh - xa, xah - xaa, 0.0, fh - fa,
                abs(eh - ea), xh + xa,
                0.0, WC_IMPORTANCE, h2h_for(h2h_table, home, away),
                xh * xaa - xa * xah, 0.0, 0.0,
            ])
            keys.append(f"{normalize_name(home)}|{normalize_name(away)}")

    # Which model families does the champion need at deployment?
    feat_tag = champ_tag if champ_tag in candidates else (
        "ensemble" if champ_tag == "dc_blend" else None)
    p_feat = p_dc = None
    if feat_tag is not None and feat_rows:
        final = fit_weighted(candidates[feat_tag](), X, y, w)
        p_feat = to_hda(final, final.predict_proba(np.array(feat_rows, dtype=float)))
    if champ_tag in ("dixon_coles", "dc_blend") and pairs:
        dc_final = DixonColes().fit(full_rows, sample_weight=w_full)  # refit on ALL data
        p_dc = dc_final.predict_pairs(
            [h for h, _ in pairs], [a for _, a in pairs], adv=0.0)  # neutral WC venue

    if p_feat is not None and p_dc is not None:
        p_all = 0.5 * (p_feat + p_dc)
    else:
        p_all = p_feat if p_feat is not None else p_dc

    matchups: dict[str, list[float]] = {}
    if p_all is not None:
        for key, p in zip(keys, p_all):
            matchups[key] = [round(float(p[0]), 4), round(float(p[1]), 4), round(float(p[2]), 4)]
    print(f"  Pre-computed {len(matchups)} matchups from '{champ_tag}' → JSON.")

    return {
        "type": f"{champ_tag}_precomputed",
        "features": ML_FEATURES,
        "classes": ["H", "D", "A"],  # column order of each matchup array
        "defaults": {"elo": DEFAULT_ELO, "momentum": 50.0, "rate": DEFAULT_RATE},
        "matchups": matchups,
        # Sparse rivalry table for the UI deep-dive: canonical "lo|hi" → avg GD
        # (from the alphabetically-first team's view). Only pairs that have met.
        "h2h": {f"{lo}|{hi}": round(v, 2) for (lo, hi), v in h2h_table.items()},
        "metrics": {
            "test_matches": int(len(y_te)),
            "train_matches": int(split),
            "train_since": train_since,
            "half_life_days": float(half_life_days),
            "accuracy": round(champ_acc, 4),
            "log_loss": round(champ_ll, 4),
            "brier": round(champ_brier, 4),
            "baseline_brier": round(base_brier, 4),
            "candidates": {k: round(v, 4) for k, v in scored.items()},
        },
    }


# ── Orchestration ────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="Compute team momentum scores.")
    parser.add_argument("--input", default="results.csv", type=Path)
    parser.add_argument("--output", default="team_momentum.json", type=Path)
    parser.add_argument("--since", default=DEFAULT_SINCE,
                        help="Earliest match date to include (YYYY-MM-DD).")
    parser.add_argument("--min-matches", default=DEFAULT_MIN_MATCHES, type=int)
    parser.add_argument("--elo", default="elo_ratings.csv", type=Path,
                        help="CSV with columns country,rating,snapshot_date.")
    parser.add_argument("--xg", default="team_xg_stats.csv", type=Path,
                        help="CSV with columns team,xG_per_90,xGA_per_90.")
    parser.add_argument("--train-since", default=DEFAULT_TRAIN_SINCE,
                        help="ML training window start (earlier history is Elo/state warm-up).")
    parser.add_argument("--half-life-days", default=HALF_LIFE_DAYS, type=float,
                        help="Time-decay half-life for training sample weights.")
    args = parser.parse_args()

    df = load_and_filter(args.input, args.since)
    if df.empty:
        raise SystemExit("No competitive matches found in the selected window.")

    team_rows = to_team_perspective(df)
    agg = aggregate(team_rows, args.min_matches)
    agg = attach_elo(agg, load_elo(args.elo))      # left join + default 1500
    agg = attach_xg(agg, load_xg(args.xg))         # left join + default 1.10
    agg = attach_quality_momentum(agg, df)         # Elo-surprise momentum (needs Elo)
    agg = attach_gd_form(agg, df)                  # rolling goal-difference form
    agg.attrs["max_date"] = df["date"].max().date()
    agg = add_momentum(agg)                        # sort + rank by momentum_score
    agg = round_columns(agg)

    # Train the ML 1X2 model on the FULL history (point-in-time replay Elo,
    # wide window, time-decay weights) — independent of the display window.
    try:
        model = train_prediction_model(args.input, agg,
                                       train_since=args.train_since,
                                       half_life_days=args.half_life_days)
    except Exception as exc:  # never let modelling break the data export
        print(f"[ml] Training failed ({exc}); exporting without a model.")
        model = None

    export_json(agg, args.output, args.since, model)

    print(f"\nProcessed {len(df)} competitive matches "
          f"({df['date'].min().date()} → {df['date'].max().date()}).")
    print(f"Ranked {len(agg)} teams → {args.output}")
    print("\nTop 5 by momentum (Elo-surprise):")
    print(agg[["rank", "team", "momentum_score", "elo", "gd_form"]]
          .head().to_string(index=False))


if __name__ == "__main__":
    main()
