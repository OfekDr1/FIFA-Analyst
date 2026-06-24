"""
tune_xgboost.py
==============

Hyperparameter search to see whether a properly-tuned XGBoost can finally
beat the Logistic Regression champion on multiclass (1X2) Brier score.

Notes:
  • sklearn's built-in `neg_brier_score` is BINARY only — we define a proper
    multiclass-Brier scorer (lower is better → negated for the search).
  • The data is temporal, so the inner CV uses TimeSeriesSplit (no leakage),
    and the final verdict is on the untouched chronological hold-out test set.
  • Reuses the EXACT feature builder from compute_momentum.py (no drift).

Usage:
    pip install xgboost scikit-learn scipy pandas numpy
    python tune_xgboost.py                 # 80 random configs, 5 time-folds
    python tune_xgboost.py --n-iter 200 --cv 6
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    from scipy.stats import randint, uniform, loguniform
except ImportError:
    sys.exit("Missing deps — run:  pip install numpy pandas scipy")

try:
    from xgboost import XGBClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
    from sklearn.model_selection import RandomizedSearchCV, TimeSeriesSplit
    from sklearn.metrics import accuracy_score, log_loss
except ImportError:
    sys.exit("Missing ML deps — run:  pip install xgboost scikit-learn")

from compute_momentum import (  # noqa: E402
    load_and_filter, to_team_perspective, aggregate,
    attach_elo, load_elo, attach_xg, load_xg,
    attach_quality_momentum, attach_gd_form,
    build_match_features, ML_FEATURES,
    DEFAULT_SINCE, DEFAULT_MIN_MATCHES,
)

SCRIPT_DIR = Path(__file__).resolve().parent
LR_TARGET = 0.446  # the score to beat


# ── Data (mirrors evaluate_model.py) ─────────────────────────────────
def build_team_stats(args) -> tuple[pd.DataFrame, pd.DataFrame]:
    df = load_and_filter(args.input, args.since)
    if df.empty:
        sys.exit("No competitive matches in the selected window.")
    agg = aggregate(to_team_perspective(df), args.min_matches)
    agg = attach_elo(agg, load_elo(args.elo))
    agg = attach_xg(agg, load_xg(args.xg))
    agg = attach_quality_momentum(agg, df)
    agg = attach_gd_form(agg, df)
    return df, agg


# ── Multiclass Brier (lower better) ──────────────────────────────────
def multiclass_brier(estimator, X, y) -> float:
    """Sum-of-squared-error Brier across the 3 one-hot classes, aligned to the
    estimator's own class order. Range 0 (perfect) … 2 (worst)."""
    proba = estimator.predict_proba(X)
    classes = list(estimator.classes_)
    onehot = np.zeros_like(proba)
    for i, c in enumerate(y):
        if c in classes:
            onehot[i, classes.index(c)] = 1.0
    return float(np.mean(np.sum((proba - onehot) ** 2, axis=1)))


def neg_brier_scorer(estimator, X, y) -> float:
    # GridSearch maximises the score → negate so lower Brier = higher score.
    return -multiclass_brier(estimator, X, y)


def test_metrics(estimator, X_te, y_te) -> dict:
    """Assumes `estimator` is already fitted on the training split."""
    proba = estimator.predict_proba(X_te)
    classes = list(estimator.classes_)
    onehot = np.zeros_like(proba)
    for i, c in enumerate(y_te):
        onehot[i, classes.index(c)] = 1.0
    return {
        "brier": float(np.mean(np.sum((proba - onehot) ** 2, axis=1))),
        "acc": float(accuracy_score(y_te, estimator.predict(X_te))),
        "logloss": float(log_loss(y_te, proba, labels=classes)),
    }


# ── Main ─────────────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Tune XGBoost vs the LR champion.")
    p.add_argument("--input", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--since", default=DEFAULT_SINCE)
    p.add_argument("--min-matches", type=int, default=DEFAULT_MIN_MATCHES)
    p.add_argument("--elo", type=Path, default=SCRIPT_DIR / "elo_ratings.csv")
    p.add_argument("--xg", type=Path, default=SCRIPT_DIR / "team_xg_stats.csv")
    p.add_argument("--n-iter", type=int, default=80, help="Random configs to try.")
    p.add_argument("--cv", type=int, default=5, help="TimeSeriesSplit folds.")
    args = p.parse_args()

    df, team_stats = build_team_stats(args)
    data = build_match_features(df, team_stats)
    X = data[ML_FEATURES].to_numpy(dtype=float)
    y = data["y"].map({"H": 0, "D": 1, "A": 2}).to_numpy()

    split = int(len(X) * 0.8)
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]
    print(f"Matches {len(X)} | train {split} test {len(X_te)} | features {len(ML_FEATURES)}\n")

    # Search space: every knob that controls overfitting on noisy data.
    param_dist = {
        "n_estimators": randint(60, 450),
        "max_depth": randint(2, 6),               # 2..5 — keep it shallow
        "learning_rate": loguniform(0.01, 0.3),
        "min_child_weight": randint(1, 12),
        "subsample": uniform(0.6, 0.4),           # 0.6 .. 1.0
        "colsample_bytree": uniform(0.6, 0.4),    # 0.6 .. 1.0
        "gamma": uniform(0.0, 5.0),               # min split loss
        "reg_alpha": loguniform(1e-3, 10.0),      # L1
        "reg_lambda": loguniform(1e-1, 20.0),     # L2
    }

    base = XGBClassifier(
        eval_metric="mlogloss", tree_method="hist",
        random_state=42, n_jobs=1,
    )
    search = RandomizedSearchCV(
        base,
        param_distributions=param_dist,
        n_iter=args.n_iter,
        scoring=neg_brier_scorer,
        cv=TimeSeriesSplit(n_splits=args.cv),   # temporal CV, no leakage
        n_jobs=-1,
        random_state=42,
        refit=True,
        verbose=1,
    )
    print(f"Searching {args.n_iter} configs × {args.cv} time-folds "
          f"= {args.n_iter * args.cv} fits …\n")
    search.fit(X_tr, y_tr)

    print("\n── Best XGBoost configuration ──")
    for k, v in sorted(search.best_params_.items()):
        v = round(v, 5) if isinstance(v, float) else v
        print(f"  {k:<18} {v}")
    print(f"  CV Brier (mean over folds): {-search.best_score_:.4f}")

    # ── Head-to-head on the untouched chronological test set ──
    lr = make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, C=1.0))
    lr.fit(X_tr, y_tr)

    default_xgb = XGBClassifier(
        n_estimators=80, learning_rate=0.05, max_depth=2, min_child_weight=5,
        subsample=0.8, colsample_bytree=0.8, gamma=1.0, reg_alpha=0.5,
        reg_lambda=2.0, eval_metric="mlogloss", random_state=42, n_jobs=2,
    )
    default_xgb.fit(X_tr, y_tr)

    table = {
        "Logistic Regression (champion)": test_metrics(lr, X_te, y_te),
        "XGBoost (current default)": test_metrics(default_xgb, X_te, y_te),
        "XGBoost (TUNED)": test_metrics(search.best_estimator_, X_te, y_te),
    }

    print("\n── Hold-out test results ──")
    print(f"  {'model':<34}{'Brier':>9}{'Acc':>8}{'LogLoss':>10}")
    for name, mtr in table.items():
        print(f"  {name:<34}{mtr['brier']:>9.4f}{mtr['acc']:>8.3f}{mtr['logloss']:>10.4f}")

    tuned = table["XGBoost (TUNED)"]["brier"]
    lr_brier = table["Logistic Regression (champion)"]["brier"]
    print()
    if tuned < lr_brier:
        print(f"🏁 Ferrari wins! Tuned XGBoost {tuned:.4f} beats LR {lr_brier:.4f} "
              f"(Δ {lr_brier - tuned:+.4f}).")
        print("   → Paste these params into build_xgb() in compute_momentum.py.")
    else:
        print(f"🏁 LR still leads: {lr_brier:.4f} vs tuned XGBoost {tuned:.4f} "
              f"(Δ {tuned - lr_brier:+.4f}).")
        print("   → On this much data, the linear model is genuinely hard to beat. "
              "Consider more/better features over more tuning.")


if __name__ == "__main__":
    main()
