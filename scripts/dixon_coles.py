"""
dixon_coles.py
==============

Dixon-Coles (1997) goal model: home/away goals ~ Poisson with team attack and
defence strengths, a venue-advantage term, and the DC low-score correlation
correction (rho) that fixes the independent-Poisson bias exactly where draws
live (0-0, 1-0, 0-1, 1-1).

Why it earns a seat next to the classifiers: a 1X2 label throws away the
scoreline (a 5-0 and a 1-0 are both just "H"). DC trains on GOALS — more signal
per match — and derives P(H/D/A) by summing a score grid, so draw probability
emerges from low-scoring dynamics instead of being a class nobody predicts.

Fitting (robust two-stage, standard practice):
  1. Attack/defence/venue via a decay-weighted sparse Poisson GLM
     (sklearn PoissonRegressor; L2 shrinks rarely-seen teams to league average).
  2. rho via a 1-D likelihood search holding the lambdas fixed.

Venue: rows carry is_home_advantage ∈ {1, 0, -1} (compute_momentum convention):
+1 → nominal home team hosts, -1 → the listed away team hosts, 0 → neutral.
Deployment at a neutral World Cup passes adv=0.

Self-test CLI (fits on the shared pipeline frame, prints the parameters):
    python dixon_coles.py
"""

from __future__ import annotations

import math
import unicodedata

import numpy as np
import pandas as pd

MAX_GOALS = 10          # score-grid truncation (P(>10) is negligible)
RHO_BOUNDS = (-0.2, 0.2)
ALPHA = 0.01            # GLM L2 — shrinks small-sample teams toward average


def _norm(name: object) -> str:
    text = unicodedata.normalize("NFKD", str(name))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.strip().lower()


class DixonColes:
    """fit(rows[, sample_weight]) → predict_rows / predict_pairs → (n, 3) of
    [pHome, pDraw, pAway]. Rows need columns: home_team, away_team, home_score,
    away_score, is_home_advantage."""

    def __init__(self, alpha: float = ALPHA, max_goals: int = MAX_GOALS):
        self.alpha = alpha
        self.max_goals = max_goals

    # ── Stage 1: attack / defence / venue via weighted Poisson GLM ──
    def fit(self, rows: pd.DataFrame, sample_weight=None) -> "DixonColes":
        from scipy import sparse
        from scipy.optimize import minimize_scalar
        from sklearn.linear_model import PoissonRegressor

        rows = rows.reset_index(drop=True)
        n = len(rows)
        w = np.ones(n) if sample_weight is None else np.asarray(sample_weight, dtype=float)

        homes = rows["home_team"].map(_norm).to_numpy()
        aways = rows["away_team"].map(_norm).to_numpy()
        adv = rows["is_home_advantage"].to_numpy(dtype=float)
        hg = rows["home_score"].to_numpy(dtype=float)
        ag = rows["away_score"].to_numpy(dtype=float)

        self.teams_ = sorted(set(homes) | set(aways))
        idx = {t: i for i, t in enumerate(self.teams_)}
        T = len(self.teams_)

        # Two observations per match: goals BY home (attack_home + defwk_away)
        # and goals BY away (attack_away + defwk_home). Venue bonus goes to
        # whichever side actually hosts. Columns: [attack | def-weakness | hfa].
        obs_rows, obs_cols, obs_vals = [], [], []
        y = np.empty(2 * n)
        ww = np.empty(2 * n)
        for i in range(n):
            hi, ai = idx[homes[i]], idx[aways[i]]
            r1, r2 = 2 * i, 2 * i + 1
            # home side scoring
            obs_rows += [r1, r1]
            obs_cols += [hi, T + ai]
            obs_vals += [1.0, 1.0]
            if adv[i] == 1.0:
                obs_rows.append(r1); obs_cols.append(2 * T); obs_vals.append(1.0)
            y[r1], ww[r1] = hg[i], w[i]
            # away side scoring
            obs_rows += [r2, r2]
            obs_cols += [ai, T + hi]
            obs_vals += [1.0, 1.0]
            if adv[i] == -1.0:
                obs_rows.append(r2); obs_cols.append(2 * T); obs_vals.append(1.0)
            y[r2], ww[r2] = ag[i], w[i]

        X = sparse.csr_matrix((obs_vals, (obs_rows, obs_cols)), shape=(2 * n, 2 * T + 1))
        glm = PoissonRegressor(alpha=self.alpha, max_iter=500)
        glm.fit(X, y, sample_weight=ww)

        self.intercept_ = float(glm.intercept_)
        self.attack_ = np.asarray(glm.coef_[:T], dtype=float)
        self.defwk_ = np.asarray(glm.coef_[T:2 * T], dtype=float)   # +ve = leaky
        self.home_adv_ = float(glm.coef_[2 * T])
        self._idx = idx

        # ── Stage 2: rho via 1-D weighted likelihood (only the 4 low-score
        #    cells depend on it; lambdas held fixed) ──
        lh, la = self._lambdas(homes, aways, adv)
        low = (hg <= 1) & (ag <= 1)

        def neg_ll(rho: float) -> float:
            tau = np.ones(low.sum())
            xh, xa = hg[low], ag[low]
            lhh, laa = lh[low], la[low]
            tau = np.where((xh == 0) & (xa == 0), 1.0 - lhh * laa * rho, tau)
            tau = np.where((xh == 0) & (xa == 1), 1.0 + lhh * rho, tau)
            tau = np.where((xh == 1) & (xa == 0), 1.0 + laa * rho, tau)
            tau = np.where((xh == 1) & (xa == 1), 1.0 - rho, tau)
            return -float(np.sum(w[low] * np.log(np.clip(tau, 1e-10, None))))

        res = minimize_scalar(neg_ll, bounds=RHO_BOUNDS, method="bounded")
        self.rho_ = float(res.x)
        return self

    # ── Lambdas ──────────────────────────────────────────────────────
    def _strength(self, names: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        att = np.zeros(len(names))
        dfw = np.zeros(len(names))
        for i, t in enumerate(names):
            j = self._idx.get(t)
            if j is not None:          # unknown team → league average (0, 0)
                att[i] = self.attack_[j]
                dfw[i] = self.defwk_[j]
        return att, dfw

    def _lambdas(self, homes, aways, adv) -> tuple[np.ndarray, np.ndarray]:
        att_h, dfw_h = self._strength(homes)
        att_a, dfw_a = self._strength(aways)
        adv = np.asarray(adv, dtype=float)
        lh = np.exp(self.intercept_ + att_h + dfw_a + self.home_adv_ * (adv == 1.0))
        la = np.exp(self.intercept_ + att_a + dfw_h + self.home_adv_ * (adv == -1.0))
        return lh, la

    # ── Score grid → 1X2, vectorised across matches ──────────────────
    def _grid_1x2(self, lh: np.ndarray, la: np.ndarray) -> np.ndarray:
        k = np.arange(self.max_goals + 1)
        fact = np.array([math.factorial(int(i)) for i in k], dtype=float)
        ph = np.exp(-lh)[:, None] * lh[:, None] ** k / fact   # (n, K+1)
        pa = np.exp(-la)[:, None] * la[:, None] ** k / fact

        cum_pa = np.cumsum(pa, axis=1)                        # P(away ≤ j)
        p_draw = np.sum(ph * pa, axis=1)
        p_home = np.sum(ph[:, 1:] * cum_pa[:, :-1], axis=1)   # home i > away j
        p_away = np.sum(pa[:, 1:] * np.cumsum(ph, axis=1)[:, :-1], axis=1)

        # DC low-score correction: shift mass between the 4 corner cells.
        r = self.rho_
        p_draw = p_draw + ph[:, 0] * pa[:, 0] * (-lh * la * r) + ph[:, 1] * pa[:, 1] * (-r)
        p_away = p_away + ph[:, 0] * pa[:, 1] * (lh * r)
        p_home = p_home + ph[:, 1] * pa[:, 0] * (la * r)

        p = np.clip(np.column_stack([p_home, p_draw, p_away]), 1e-9, None)
        return p / p.sum(axis=1, keepdims=True)               # renormalise (truncation+tau)

    # ── Public predict API ───────────────────────────────────────────
    def predict_rows(self, rows: pd.DataFrame) -> np.ndarray:
        """[pH, pD, pA] per row, honouring each row's is_home_advantage."""
        homes = rows["home_team"].map(_norm).to_numpy()
        aways = rows["away_team"].map(_norm).to_numpy()
        lh, la = self._lambdas(homes, aways, rows["is_home_advantage"].to_numpy(dtype=float))
        return self._grid_1x2(lh, la)

    def predict_pairs(self, homes: list[str], aways: list[str], adv: float = 0.0) -> np.ndarray:
        """[pH, pD, pA] for raw team-name pairs at a fixed venue context
        (adv=0 → neutral, the World Cup deployment case)."""
        h = np.array([_norm(t) for t in homes])
        a = np.array([_norm(t) for t in aways])
        lh, la = self._lambdas(h, a, np.full(len(h), adv))
        return self._grid_1x2(lh, la)


# ── Self-test: fit on the FULL history (friendlies included), show params ──
def main() -> None:
    # Runtime imports (compute_momentum imports this module — avoid a cycle).
    from pathlib import Path
    from compute_elo import load_history
    from compute_momentum import home_advantage

    full = load_history(Path(__file__).resolve().parent / "results.csv")
    rows = pd.DataFrame({
        "home_team": full["home_team"], "away_team": full["away_team"],
        "home_score": full["home_score"], "away_score": full["away_score"],
        "is_home_advantage": full.apply(home_advantage, axis=1),
    })
    age = (full["date"].max() - full["date"]).dt.days.to_numpy(dtype=float)
    friendly = full["tournament"].fillna("").str.strip().str.lower().eq("friendly")
    # Friendlies at half weight: squads rotate, but they're the only regular
    # cross-conference fixtures — the glue that anchors CONMEBOL vs UEFA.
    w = 0.5 ** (age / 730.0) * np.where(friendly, 0.5, 1.0)

    dc = DixonColes().fit(rows, sample_weight=w)
    print(f"[dc] {len(dc.teams_)} teams · home_adv {dc.home_adv_:+.3f} "
          f"· rho {dc.rho_:+.4f} · baseline {math.exp(dc.intercept_):.2f} goals/90")

    order = np.argsort(-dc.attack_)
    print("\nTop 8 attacks:")
    for j in order[:8]:
        print(f"  {dc.teams_[j]:<22}attack {dc.attack_[j]:+.3f}")
    order = np.argsort(dc.defwk_)
    print("\nTop 8 defences (least leaky):")
    for j in order[:8]:
        print(f"  {dc.teams_[j]:<22}def {dc.defwk_[j]:+.3f}")

    demo = [("Argentina", "France"), ("Brazil", "Panama"), ("Spain", "England")]
    p = dc.predict_pairs([h for h, _ in demo], [a for _, a in demo], adv=0.0)
    print("\nNeutral-venue demos:")
    for (h, a), row in zip(demo, p):
        print(f"  {h} v {a}:  H {row[0]:.2f} · D {row[1]:.2f} · A {row[2]:.2f}")


if __name__ == "__main__":
    main()
