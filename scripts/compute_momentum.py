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
DEFAULT_MIN_MATCHES = 3        # ignore teams with too few games (noisy)
GD_CLIP = 3.0                  # clamp avg goal difference to ±3 before scaling
W_WIN_RATE = 0.60              # weight: results matter most
W_GOAL_DIFF = 0.40             # weight: margin/quality of those results
# Weights sum to 1.0 so the weighted blend of two 0–100 inputs stays 0–100.
DEFAULT_ELO = 1500             # baseline when a team has no Elo rating
DEFAULT_XG = 1.10              # tournament-baseline xG / xGA per 90 (missing teams)


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


# ── 4. Momentum score ────────────────────────────────────────────────
def add_momentum(g: pd.DataFrame) -> pd.DataFrame:
    """
    momentum_score ∈ [0, 100] = blend of two 0–100 sub-scores:

        win_rate            already 0–100
        gd_score            avg goal diff clamped to [-3, +3] then
                            linearly mapped to 0–100 (0 GD → 50)

        momentum = 0.60 * win_rate + 0.40 * gd_score
    """
    gd_clamped = g["avg_goal_difference"].clip(-GD_CLIP, GD_CLIP)
    gd_score = (gd_clamped + GD_CLIP) / (2 * GD_CLIP) * 100.0  # → 0..100

    g["momentum_score"] = W_WIN_RATE * g["win_rate"] + W_GOAL_DIFF * gd_score

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
    }
    for col, places in rounding.items():
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
        "weights": {"win_rate": W_WIN_RATE, "goal_difference": W_GOAL_DIFF},
        "count": len(teams),
        "teams": teams,
        # Learned 1X2 model (coefficients) for the TS engine — Option A.
        "model": model,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


# ── ML model: learn optimal 1X2 weights & minimise Brier ─────────────
ML_FEATURES = ["elo_diff", "momentum_diff", "xg_diff", "xga_diff"]


def train_prediction_model(matches: pd.DataFrame, team_stats: pd.DataFrame):
    """
    Train a multinomial Logistic Regression to predict 1X2 outcomes from
    Home-minus-Away feature differences (Elo, momentum, xG, xGA).

    Returns a serialisable dict of learned coefficients + scaler params so
    the TypeScript engine can apply softmax(W·x + b) at runtime (Option A).
    Returns None if scikit-learn is unavailable or there's too little data.
    """
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.preprocessing import StandardScaler
        from sklearn.metrics import accuracy_score, log_loss
    except ImportError:
        print("[ml] scikit-learn not installed — skipping. `pip install scikit-learn`")
        return None

    # Index team stats by normalized name for O(1) per-team lookups.
    by_key = team_stats.assign(_key=team_stats["team"].map(normalize_name))
    by_key = by_key.drop_duplicates("_key").set_index("_key")

    def feat(name: str, col: str, default: float) -> float:
        key = normalize_name(name)
        if key in by_key.index:
            val = by_key.at[key, col]
            return float(val) if pd.notna(val) else default
        return default

    # 2 & 3 — engineer features (X) and the outcome target (y) per match.
    rows = []
    for _, m in matches.iterrows():
        h, a = m["home_team"], m["away_team"]
        if m["home_score"] > m["away_score"]:
            y = "H"
        elif m["home_score"] < m["away_score"]:
            y = "A"
        else:
            y = "D"
        rows.append({
            "date": m["date"],
            "elo_diff": feat(h, "elo", DEFAULT_ELO) - feat(a, "elo", DEFAULT_ELO),
            "momentum_diff": feat(h, "momentum_score", 50.0) - feat(a, "momentum_score", 50.0),
            "xg_diff": feat(h, "xG_per_90", DEFAULT_XG) - feat(a, "xG_per_90", DEFAULT_XG),
            "xga_diff": feat(h, "xGA_per_90", DEFAULT_XG) - feat(a, "xGA_per_90", DEFAULT_XG),
            "y": y,
        })

    data = pd.DataFrame(rows).dropna(subset=ML_FEATURES + ["y"]).sort_values("date")
    if len(data) < 50:
        print(f"[ml] Only {len(data)} usable matches — too few to train; skipping.")
        return None

    X = data[ML_FEATURES].to_numpy(dtype=float)
    y = data["y"].to_numpy()

    # 5 — honest chronological split (train on the past, test on the future).
    split = int(len(data) * 0.8)
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]

    scaler = StandardScaler().fit(X_tr)
    model = LogisticRegression(max_iter=1000, C=1.0)
    model.fit(scaler.transform(X_tr), y_tr)

    classes = list(model.classes_)              # alphabetical: ['A', 'D', 'H']
    proba = model.predict_proba(scaler.transform(X_te))
    preds = model.predict(scaler.transform(X_te))

    # One-hot the test targets to score the probabilistic forecasts.
    Y = np.zeros_like(proba)
    for i, yy in enumerate(y_te):
        Y[i, classes.index(yy)] = 1.0
    brier = float(np.mean(np.sum((proba - Y) ** 2, axis=1)))

    # Baseline = predict the train-set class frequencies for every match.
    freq = pd.Series(y_tr).value_counts(normalize=True)
    base = np.tile([freq.get(c, 0.0) for c in classes], (len(y_te), 1))
    base_brier = float(np.mean(np.sum((base - Y) ** 2, axis=1)))

    acc = accuracy_score(y_te, preds)
    ll = log_loss(y_te, proba, labels=classes)

    print("\n── ML 1X2 model — multinomial Logistic Regression ──")
    print(f"  Train / test (chronological): {split} / {len(y_te)}")
    print(f"  Accuracy:     {acc:.3f}")
    print(f"  Log loss:     {ll:.3f}")
    print(f"  Brier score:  {brier:.3f}   (baseline {base_brier:.3f}, "
          f"{'better ✓' if brier < base_brier else 'no gain ✗'})")
    print("  Learned weights (standardised features):")
    for k, c in enumerate(classes):
        terms = "  ".join(f"{f}={model.coef_[k][j]:+.3f}"
                          for j, f in enumerate(ML_FEATURES))
        print(f"    P({c}): b={model.intercept_[k]:+.3f}   {terms}")

    return {
        "type": "multinomial_logistic_regression",
        "features": ML_FEATURES,
        "means": [round(v, 6) for v in scaler.mean_.tolist()],
        "stds": [round(v, 6) for v in scaler.scale_.tolist()],
        "classes": classes,
        "coef": [[round(v, 6) for v in row] for row in model.coef_.tolist()],
        "intercept": [round(v, 6) for v in model.intercept_.tolist()],
        "defaults": {"elo": DEFAULT_ELO, "momentum": 50.0, "xg": DEFAULT_XG, "xga": DEFAULT_XG},
        "metrics": {
            "test_matches": int(len(y_te)),
            "accuracy": round(acc, 4),
            "log_loss": round(ll, 4),
            "brier": round(brier, 4),
            "baseline_brier": round(base_brier, 4),
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
    agg = attach_elo(agg, load_elo(args.elo))  # left join + default 1500
    agg = attach_xg(agg, load_xg(args.xg))     # left join + default 1.10
    agg.attrs["max_date"] = df["date"].max().date()
    agg = add_momentum(agg)
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
    print("\nTop 5 by momentum:")
    print(agg[["rank", "team", "momentum_score", "elo", "xG_per_90",
               "xGA_per_90"]].head().to_string(index=False))


if __name__ == "__main__":
    main()
