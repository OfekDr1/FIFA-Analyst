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
    "elo_diff", "momentum_diff", "xg_diff", "xga_diff", "rest_diff", "gd_form_diff",
    # Draw-awareness: |elo gap| encodes "evenness" (the U-shaped draw signal a
    # linear model can't get from elo_diff alone); total_xg captures low-scoring
    # (draw-prone) games. Calibration-preserving — no class weighting needed.
    "abs_elo_diff", "total_xg",
]


def build_match_features(matches: pd.DataFrame, team_stats: pd.DataFrame) -> pd.DataFrame:
    """
    Chronological, point-in-time feature frame — one row per match with the
    ML_FEATURES diffs + the outcome y. Shared by training (compute_momentum)
    and evaluation (evaluate_model) so the two can never drift apart.

    rest_diff and gd_form_diff are computed from matches STRICTLY BEFORE each
    game (no leakage); the rest come from the team-level aggregates.
    """
    by_key = (
        team_stats.assign(_key=team_stats["team"].map(normalize_name))
        .drop_duplicates("_key").set_index("_key")
    )

    def feat(name: str, col: str, default: float) -> float:
        key = normalize_name(name)
        if key in by_key.index:
            val = by_key.at[key, col]
            return float(val) if pd.notna(val) else default
        return default

    last_played: dict[str, object] = {}
    gd_hist: dict[str, list[int]] = {}
    rows = []
    for _, m in matches.sort_values("date").iterrows():
        h, a, d = m["home_team"], m["away_team"], m["date"]
        hs, as_ = m["home_score"], m["away_score"]
        yv = "H" if hs > as_ else ("A" if hs < as_ else "D")

        rest_h = (d - last_played[h]).days if h in last_played else REST_DEFAULT
        rest_a = (d - last_played[a]).days if a in last_played else REST_DEFAULT
        gd_h = float(sum(gd_hist.get(h, [])[-GD_WINDOW:]))
        gd_a = float(sum(gd_hist.get(a, [])[-GD_WINDOW:]))

        eh, ea = feat(h, "elo", DEFAULT_ELO), feat(a, "elo", DEFAULT_ELO)
        xh, xa = feat(h, "xG_per_90", DEFAULT_XG), feat(a, "xG_per_90", DEFAULT_XG)

        rows.append({
            "date": d,
            "elo_diff": eh - ea,
            "momentum_diff": feat(h, "momentum_score", 50.0) - feat(a, "momentum_score", 50.0),
            "xg_diff": xh - xa,
            "xga_diff": feat(h, "xGA_per_90", DEFAULT_XG) - feat(a, "xGA_per_90", DEFAULT_XG),
            "rest_diff": float(rest_h - rest_a),
            "gd_form_diff": gd_h - gd_a,
            "abs_elo_diff": abs(eh - ea),
            "total_xg": xh + xa,
            "y": yv,
        })

        last_played[h] = d
        last_played[a] = d
        gd_hist.setdefault(h, []).append(int(hs - as_))
        gd_hist.setdefault(a, []).append(int(as_ - hs))

    return pd.DataFrame(rows).dropna(subset=ML_FEATURES + ["y"]).sort_values("date")


def train_prediction_model(matches: pd.DataFrame, team_stats: pd.DataFrame):
    """
    Predict 1X2 outcomes from Home-minus-Away feature diffs (Elo, momentum,
    xG, xGA). Trains TWO candidates — a heavily-regularised XGBoost and a
    Logistic Regression — scores both on a held-out chronological split, and
    PRE-COMPUTES every matchup's win/draw/away probabilities from whichever
    has the lower Brier. So we can never ship a model worse than the LR
    baseline. The winner's probabilities are exported as a lookup:
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

    # Point-in-time feature frame (shared with evaluate_model.py — no drift).
    data = build_match_features(matches, team_stats)
    if len(data) < 50:
        print(f"[ml] Only {len(data)} usable matches — too few to train; skipping.")
        return None

    # feat() helper for the deployment pre-compute (team-level; no fixture date).
    by_key = (
        team_stats.assign(_key=team_stats["team"].map(normalize_name))
        .drop_duplicates("_key").set_index("_key")
    )

    def feat(name: str, col: str, default: float) -> float:
        key = normalize_name(name)
        if key in by_key.index:
            val = by_key.at[key, col]
            return float(val) if pd.notna(val) else default
        return default

    X = data[ML_FEATURES].to_numpy(dtype=float)

    # 4 — integer classes 0..K-1.  Home win=0, Draw=1, Away win=2.
    y = data["y"].map({"H": 0, "D": 1, "A": 2}).to_numpy()

    # Honest chronological split (train on the past, test on the future).
    split = int(len(data) * 0.8)
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]

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

    # 3 — HEAVILY regularised XGBoost (shallow trees, slow LR, strong
    #     subsampling + L1/L2 + min_child_weight + gamma) for noisy data.
    def build_xgb():
        return XGBClassifier(
            n_estimators=383,
            learning_rate=0.11818,
            max_depth=4,
            min_child_weight=4,
            subsample=0.86055,
            colsample_bytree=0.64032,
            gamma=1.28008,
            reg_alpha=1.44657,
            reg_lambda=0.11297,
            eval_metric="mlogloss",
            random_state=42,
            n_jobs=2,
        )

    def build_lr():
        return make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=1000, C=1.0)
        )

    candidates = {"xgboost": build_xgb, "logistic_regression": build_lr}
    scored = {}
    for tag, build in candidates.items():
        clf = build()
        clf.fit(X_tr, y_tr)
        proba_hda = to_hda(clf, clf.predict_proba(X_te))
        scored[tag] = brier_of(proba_hda, y_te)

    # No-skill baseline (predict train class frequencies for everything).
    freq = pd.Series(y_tr).value_counts(normalize=True)
    base = np.tile([freq.get(0, 0.0), freq.get(1, 0.0), freq.get(2, 0.0)], (len(y_te), 1))
    base_brier = brier_of(base, y_te)

    # Champion = lowest test Brier.
    champ_tag = min(scored, key=scored.get)
    champ = candidates[champ_tag]()
    champ.fit(X_tr, y_tr)
    champ_proba = to_hda(champ, champ.predict_proba(X_te))
    champ_brier = scored[champ_tag]
    champ_acc = float(accuracy_score(y_te, champ_proba.argmax(axis=1)))
    champ_ll = float(log_loss(y_te, champ_proba, labels=[0, 1, 2]))

    print("\n── ML 1X2 model selection (held-out Brier) ──")
    for tag, b in sorted(scored.items(), key=lambda kv: kv[1]):
        mark = " ← champion" if tag == champ_tag else ""
        print(f"  {tag:<22} Brier {b:.3f}{mark}")
    print(f"  {'baseline (no-skill)':<22} Brier {base_brier:.3f}")
    print(f"  Champion accuracy {champ_acc:.3f} · log-loss {champ_ll:.3f}")

    # ── Refit champion on ALL data, pre-compute every matchup ──
    final = candidates[champ_tag]()
    final.fit(X, y)

    teams_list = list(team_stats["team"])
    tf = {
        t: (
            feat(t, "elo", DEFAULT_ELO),
            feat(t, "momentum_score", 50.0),
            feat(t, "xG_per_90", DEFAULT_XG),
            feat(t, "xGA_per_90", DEFAULT_XG),
            feat(t, "gd_form", 0.0),
        )
        for t in teams_list
    }

    # Feature order must match ML_FEATURES. At deployment there's no fixture
    # date, so rest_diff = 0 (equal-rest assumption).
    keys, feat_rows = [], []
    for home in teams_list:
        for away in teams_list:
            if home == away:
                continue
            eh, mh, xh, xah, fh = tf[home]
            ea, ma, xa, xaa, fa = tf[away]
            # Order MUST match ML_FEATURES (rest_diff = 0 at deployment).
            feat_rows.append([
                eh - ea, mh - ma, xh - xa, xah - xaa, 0.0, fh - fa,
                abs(eh - ea), xh + xa,
            ])
            keys.append(f"{normalize_name(home)}|{normalize_name(away)}")

    matchups: dict[str, list[float]] = {}
    if feat_rows:
        p_all = to_hda(final, final.predict_proba(np.array(feat_rows, dtype=float)))
        for key, p in zip(keys, p_all):
            matchups[key] = [round(float(p[0]), 4), round(float(p[1]), 4), round(float(p[2]), 4)]
    print(f"  Pre-computed {len(matchups)} matchups from '{champ_tag}' → JSON.")

    return {
        "type": f"{champ_tag}_precomputed",
        "features": ML_FEATURES,
        "classes": ["H", "D", "A"],  # column order of each matchup array
        "defaults": {"elo": DEFAULT_ELO, "momentum": 50.0, "xg": DEFAULT_XG, "xga": DEFAULT_XG},
        "matchups": matchups,
        "metrics": {
            "test_matches": int(len(y_te)),
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

    # Train the ML 1X2 model on history + the engineered team features.
    try:
        model = train_prediction_model(df, agg)
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
