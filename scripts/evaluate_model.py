"""
evaluate_model.py
=================

Deep-dive diagnostics for the 1X2 models. Recreates the exact feature
engineering + chronological split from compute_momentum.py (imported, so the
features can never drift), trains both the Logistic Regression (champion) and
the XGBoost (challenger), and on the hold-out TEST set produces:

  • Confusion matrices (per model) — spot under-predicted Draws / Away wins.
  • A pooled reliability diagram — compare LR vs XGBoost calibration.
  • Brier Skill Score (BSS) vs a climatology baseline (base-rate forecast).

Usage:
    pip install xgboost scikit-learn matplotlib pandas numpy   # seaborn optional
    python evaluate_model.py
    python evaluate_model.py --no-show          # save PNG only (headless)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
except ImportError:
    sys.exit("Missing deps — run:  pip install numpy pandas")

try:
    import matplotlib.pyplot as plt
except ImportError:
    sys.exit("Missing matplotlib — run:  pip install matplotlib")

try:
    from xgboost import XGBClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
    from sklearn.metrics import (
        accuracy_score, log_loss, confusion_matrix,
        ConfusionMatrixDisplay, classification_report,
    )
    from sklearn.calibration import calibration_curve
except ImportError:
    sys.exit("Missing ML deps — run:  pip install xgboost scikit-learn")

try:
    import seaborn as sns
    sns.set_theme(style="whitegrid", context="talk")
except ImportError:
    pass  # seaborn is purely cosmetic here

# Reuse the EXACT pipeline pieces from compute_momentum.py (single source of
# truth — including the feature builder, so the two scripts can never drift).
from compute_momentum import (  # noqa: E402
    load_and_filter, to_team_perspective, aggregate,
    attach_elo, load_elo, attach_xg, load_xg,
    attach_quality_momentum, attach_gd_form,
    build_match_features, ML_FEATURES,
    DEFAULT_SINCE, DEFAULT_MIN_MATCHES,
)

SCRIPT_DIR = Path(__file__).resolve().parent
CLASS_LABELS = ["Home", "Draw", "Away"]  # integer 0, 1, 2


# ── Model builders — MUST match compute_momentum.py ──────────────────
def build_lr():
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000, C=1.0))


def build_xgb():
    return XGBClassifier(
        n_estimators=80, learning_rate=0.05, max_depth=2, min_child_weight=5,
        subsample=0.8, colsample_bytree=0.8, gamma=1.0,
        reg_alpha=0.5, reg_lambda=2.0,
        eval_metric="mlogloss", random_state=42, n_jobs=2,
    )


# ── Data + features (mirrors compute_momentum.train_prediction_model) ─
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


def build_feature_matrix(matches: pd.DataFrame, team_stats: pd.DataFrame):
    """Thin wrapper around compute_momentum.build_match_features so the exact
    same features (including new ones) are always used."""
    data = build_match_features(matches, team_stats)
    X = data[ML_FEATURES].to_numpy(dtype=float)
    y = data["y"].map({"H": 0, "D": 1, "A": 2}).to_numpy()
    return X, y


# ── Metric helpers ───────────────────────────────────────────────────
def to_hda(model, proba: np.ndarray) -> np.ndarray:
    """Reorder predict_proba columns to fixed [Home, Draw, Away]."""
    col = {int(c): i for i, c in enumerate(model.classes_)}
    n = len(proba)
    return np.column_stack([
        proba[:, col[0]] if 0 in col else np.zeros(n),
        proba[:, col[1]] if 1 in col else np.zeros(n),
        proba[:, col[2]] if 2 in col else np.zeros(n),
    ])


def multiclass_brier(proba: np.ndarray, y: np.ndarray) -> float:
    onehot = np.eye(3)[y]
    return float(np.mean(np.sum((proba - onehot) ** 2, axis=1)))


def relative_importance(model) -> np.ndarray:
    """Per-feature importance normalised to sum to 1, so the two models are
    comparable. LR pipeline → mean |standardised coefficient| across classes;
    XGBoost → gain-based feature_importances_."""
    if hasattr(model, "named_steps"):  # sklearn Pipeline = Logistic Regression
        coef = np.asarray(model[-1].coef_, dtype=float)  # (n_classes, n_features)
        imp = np.abs(coef).mean(axis=0)
    else:  # XGBoost
        imp = np.asarray(model.feature_importances_, dtype=float)
    total = imp.sum()
    return imp / total if total > 0 else imp


# ── Main ─────────────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Diagnose the 1X2 models.")
    p.add_argument("--input", type=Path, default=SCRIPT_DIR / "results.csv")
    p.add_argument("--since", default=DEFAULT_SINCE)
    p.add_argument("--min-matches", type=int, default=DEFAULT_MIN_MATCHES)
    p.add_argument("--elo", type=Path, default=SCRIPT_DIR / "elo_ratings.csv")
    p.add_argument("--xg", type=Path, default=SCRIPT_DIR / "team_xg_stats.csv")
    p.add_argument("--out", type=Path, default=SCRIPT_DIR / "model_diagnostics.png")
    p.add_argument("--no-show", action="store_true", help="Save the figure but don't open a window.")
    args = p.parse_args()

    df, team_stats = build_team_stats(args)
    X, y = build_feature_matrix(df, team_stats)

    # Same chronological 80/20 split as production.
    split = int(len(X) * 0.8)
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]
    print(f"Matches: {len(X)}  |  train {split}  test {len(X_te)}  |  features {len(ML_FEATURES)}")

    # Climatology baseline = train-set base rates of H/D/A.
    base_rates = np.array([(y_tr == k).mean() for k in range(3)])
    clim = np.tile(base_rates, (len(y_te), 1))
    bs_ref = multiclass_brier(clim, y_te)
    print(f"Base rates (H/D/A): {base_rates.round(3)}   climatology Brier {bs_ref:.4f}\n")

    models = {"Logistic Regression": build_lr(), "XGBoost": build_xgb()}
    results = {}
    for name, model in models.items():
        model.fit(X_tr, y_tr)
        proba = to_hda(model, model.predict_proba(X_te))
        preds = proba.argmax(axis=1)
        bs = multiclass_brier(proba, y_te)
        results[name] = {
            "model": model,
            "proba": proba, "preds": preds,
            "brier": bs,
            "bss": 1.0 - bs / bs_ref,                 # Brier Skill Score
            "acc": accuracy_score(y_te, preds),
            "logloss": log_loss(y_te, proba, labels=[0, 1, 2]),
        }

        print(f"── {name} ──")
        print(f"  Accuracy {results[name]['acc']:.3f} · LogLoss {results[name]['logloss']:.3f} "
              f"· Brier {bs:.4f} · BSS {results[name]['bss']:+.3f}")
        print(classification_report(y_te, preds, labels=[0, 1, 2],
                                    target_names=CLASS_LABELS, zero_division=0, digits=3))

    # ── Figure: confusion matrices (top) · reliability + importances (bottom) ──
    fig, axes = plt.subplots(2, 2, figsize=(16, 13))

    for ax, (name, r) in zip((axes[0, 0], axes[0, 1]), results.items()):
        cm = confusion_matrix(y_te, r["preds"], labels=[0, 1, 2])
        ConfusionMatrixDisplay(cm, display_labels=CLASS_LABELS).plot(
            ax=ax, cmap="Blues", colorbar=False, values_format="d"
        )
        ax.set_title(f"{name}\nConfusion Matrix (test)")

    # Reliability diagram (calibration).
    rel = axes[1, 0]
    rel.plot([0, 1], [0, 1], "k--", alpha=0.6, label="Perfectly calibrated")
    for name, r in results.items():
        # Pool all three one-vs-rest forecasts for an overall reliability curve.
        prob_flat = r["proba"].ravel()
        true_flat = np.eye(3)[y_te].ravel()
        frac_pos, mean_pred = calibration_curve(true_flat, prob_flat, n_bins=10, strategy="uniform")
        rel.plot(mean_pred, frac_pos, marker="o", label=f"{name} (Brier {r['brier']:.3f})")
    rel.set_xlabel("Mean predicted probability")
    rel.set_ylabel("Observed frequency")
    rel.set_title("Reliability Diagram (pooled 1X2)\nbelow line = overconfident")
    rel.legend(loc="upper left", fontsize="small")
    rel.set_xlim(0, 1)
    rel.set_ylim(0, 1)

    # Feature importance — normalised so both models share one scale.
    imp_ax = axes[1, 1]
    ypos = np.arange(len(ML_FEATURES))
    bar_h = 0.38
    for offset, (name, r) in zip((bar_h / 2, -bar_h / 2), results.items()):
        imp = relative_importance(r["model"])
        imp_ax.barh(ypos + offset, imp, height=bar_h, label=name)
    imp_ax.set_yticks(ypos)
    imp_ax.set_yticklabels(ML_FEATURES)
    imp_ax.invert_yaxis()  # most-listed feature on top
    imp_ax.set_xlabel("Relative importance (normalised)")
    imp_ax.set_title("Feature Importance\nLR: mean |coef| (standardised) · XGB: gain")
    imp_ax.legend(loc="lower right", fontsize="small")

    # Also print it for a precise read.
    print("Feature importance (normalised):")
    print(f"  {'feature':<16}" + "".join(f"{n:>22}" for n in results))
    for j, f in enumerate(ML_FEATURES):
        vals = "".join(f"{relative_importance(r['model'])[j]:>22.3f}" for r in results.values())
        print(f"  {f:<16}{vals}")

    fig.tight_layout()
    fig.savefig(args.out, dpi=120, bbox_inches="tight")
    print(f"Saved figure → {args.out}")
    if not args.no_show:
        plt.show()


if __name__ == "__main__":
    main()
