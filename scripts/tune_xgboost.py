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
    prepare_training_data, fit_weighted, SoftVote, ML_FEATURES,
    DEFAULT_SINCE, DEFAULT_TRAIN_SINCE, HALF_LIFE_DAYS,
)

SCRIPT_DIR = Path(__file__).resolve().parent


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
    p.add_argument("--train-since", default=DEFAULT_TRAIN_SINCE,
                   help="ML training window start (earlier history is warm-up).")
    p.add_argument("--n-iter", type=int, default=80, help="Random configs to try.")
    p.add_argument("--cv", type=int, default=5, help="TimeSeriesSplit folds.")
    args = p.parse_args()

    feats, _state, _comp = prepare_training_data(args.input, args.train_since)
    X = feats[ML_FEATURES].to_numpy(dtype=float)
    y = feats["y"].map({"H": 0, "D": 1, "A": 2}).to_numpy()

    # Production split: test = most recent 20% of the last-24-months era;
    # time-decay sample weights over the wide training window.
    n_recent = int((feats["date"] >= pd.Timestamp(DEFAULT_SINCE)).sum())
    test_n = max(50, int(n_recent * 0.2))
    split = len(X) - test_n
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]
    age = (feats["date"].max() - feats["date"]).dt.days.to_numpy(dtype=float)
    w_tr = (0.5 ** (age / HALF_LIFE_DAYS))[:split]
    print(f"Matches {len(X)} | train {split} (decayed) test {len(X_te)} | features {len(ML_FEATURES)}\n")

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
    search.fit(X_tr, y_tr, sample_weight=w_tr)

    print("\n── Best XGBoost configuration ──")
    for k, v in sorted(search.best_params_.items()):
        v = round(v, 5) if isinstance(v, float) else v
        print(f"  {k:<18} {v}")
    print(f"  CV Brier (mean over folds): {-search.best_score_:.4f}")

    # ── Head-to-head on the untouched chronological test set ──
    def fresh_lr():
        return make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, C=1.0))

    def fresh_tuned_xgb():
        # An UNFITTED clone of the winner (VotingClassifier refits its members).
        return XGBClassifier(
            **search.best_params_, eval_metric="mlogloss", tree_method="hist",
            random_state=42, n_jobs=1,
        )

    lr = fit_weighted(fresh_lr(), X_tr, y_tr, w_tr)

    default_xgb = XGBClassifier(
        n_estimators=80, learning_rate=0.05, max_depth=2, min_child_weight=5,
        subsample=0.8, colsample_bytree=0.8, gamma=1.0, reg_alpha=0.5,
        reg_lambda=2.0, eval_metric="mlogloss", random_state=42, n_jobs=2,
    )
    default_xgb.fit(X_tr, y_tr, sample_weight=w_tr)

    # Soft-vote ensemble: average LR's calibrated probs with tuned-XGB's sharper
    # ones. Equal weights → leakage-free (no test-set weight search).
    ensemble = SoftVote([fresh_lr, fresh_tuned_xgb])
    ensemble.fit(X_tr, y_tr, sample_weight=w_tr)

    table = {
        "Logistic Regression (champion)": test_metrics(lr, X_te, y_te),
        "XGBoost (untuned baseline)": test_metrics(default_xgb, X_te, y_te),
        "XGBoost (TUNED)": test_metrics(search.best_estimator_, X_te, y_te),
        "Ensemble (LR + tuned XGB)": test_metrics(ensemble, X_te, y_te),
    }

    print("\n── Hold-out test results ──")
    print(f"  {'model':<34}{'Brier':>9}{'Acc':>8}{'LogLoss':>10}")
    for name, mtr in table.items():
        print(f"  {name:<34}{mtr['brier']:>9.4f}{mtr['acc']:>8.3f}{mtr['logloss']:>10.4f}")

    lr_brier = table["Logistic Regression (champion)"]["brier"]
    challengers = {k: v["brier"] for k, v in table.items() if "Logistic" not in k}
    best_name = min(challengers, key=challengers.get)
    best_brier = challengers[best_name]
    print()
    if best_brier < lr_brier:
        print(f"🏁 {best_name} wins! {best_brier:.4f} beats LR {lr_brier:.4f} "
              f"(Δ {lr_brier - best_brier:+.4f}).")
        print("   → The Champion/Challenger in compute_momentum.py will adopt it "
              "automatically once you recompute.")
    else:
        print(f"🏁 LR still leads: {lr_brier:.4f} (best challenger: {best_name} "
              f"{best_brier:.4f}, Δ {best_brier - lr_brier:+.4f}).")
        print("   → On this much data, the linear model is genuinely hard to beat. "
              "More data is the real unlock for the trees.")


if __name__ == "__main__":
    main()
