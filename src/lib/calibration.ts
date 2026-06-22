import { Match, Team } from "@/types";
import { predictMatch } from "@/lib/predictions";

// ═══════════════════════════════════════════════════════════════════
// CALIBRATION & BRIER SCORE DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════
//
// Brier score (multi-category, 1X2): mean over matches of the summed
// squared error between the predicted probability vector (H, D, A) and
// the one-hot actual outcome. Range 0 (perfect) … 2 (worst). A naive
// always-uniform guess (1/3, 1/3, 1/3) scores 2/3 ≈ 0.667 — that's the
// "no-skill" baseline to beat.
//
// Calibration bins: bucket every Home- and Away-win prediction by its
// predicted probability, then compare the model's average claimed
// probability against the ACTUAL observed win rate in that bucket.
// If the model says ~70% but those teams only won ~50%, it's
// overconfident in that range (and vice-versa).
//
// All predictions use applyMomentum: false so current form/Elo never
// leaks into the historical evaluation.
// ═══════════════════════════════════════════════════════════════════

const BIN_COUNT = 5;
const BIN_WIDTH = 1 / BIN_COUNT; // 0.2 → 0-20%, 20-40%, …, 80-100%

export interface CalibrationBin {
  label: string; // "60–80%"
  lower: number; // 0.6
  upper: number; // 0.8
  count: number; // win-predictions in this bucket
  avgPredicted: number; // mean predicted prob, 0-1
  actualRate: number; // observed win fraction, 0-1
}

export interface CalibrationReport {
  total: number; // matches graded
  samples: number; // win-prob data points (2 per match)
  brierScore: number; // 0-2, lower is better
  baseline: number; // no-skill 1X2 Brier (≈0.667)
  bins: CalibrationBin[];
}

function isFinished(m: Match): boolean {
  return m.status === undefined || m.status === "Finished";
}

function outcome(home: number, away: number): "H" | "D" | "A" {
  if (home > away) return "H";
  if (home < away) return "A";
  return "D";
}

export function computeCalibration(
  teams: Team[],
  matches: Match[]
): CalibrationReport {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const finished = matches.filter(isFinished);

  let brierSum = 0;
  let graded = 0;

  // Per-bin accumulators for win predictions (home + away pooled)
  const sumPred = new Array<number>(BIN_COUNT).fill(0);
  const sumActual = new Array<number>(BIN_COUNT).fill(0);
  const counts = new Array<number>(BIN_COUNT).fill(0);
  let samples = 0;

  const binOf = (p: number) =>
    Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(p / BIN_WIDTH)));

  for (const match of finished) {
    const homeTeam = teamById.get(match.home.teamId);
    const awayTeam = teamById.get(match.away.teamId);
    if (!homeTeam || !awayTeam) continue;

    // Only data available before kickoff. Evaluate the xG-blended Poisson
    // model (applyXG) but drop the temporary Elo/momentum modifiers.
    const prior = finished.filter((m) => m.date < match.date);
    const pred = predictMatch(homeTeam, awayTeam, teams, prior, {
      applyModifiers: false,
      applyXG: true,
    });

    // winProbability is rounded percentages — convert to fractions and
    // renormalize so they sum to exactly 1 before scoring.
    let pH = pred.winProbability.home / 100;
    let pD = pred.winProbability.draw / 100;
    let pA = pred.winProbability.away / 100;
    const s = pH + pD + pA || 1;
    pH /= s;
    pD /= s;
    pA /= s;

    const res = outcome(match.home.goals, match.away.goals);
    const oH = res === "H" ? 1 : 0;
    const oD = res === "D" ? 1 : 0;
    const oA = res === "A" ? 1 : 0;

    // Multi-category Brier contribution for this match (0..2)
    brierSum += (pH - oH) ** 2 + (pD - oD) ** 2 + (pA - oA) ** 2;
    graded++;

    // Two win-prediction data points per match feed the calibration bins.
    for (const [p, o] of [
      [pH, oH],
      [pA, oA],
    ] as const) {
      const b = binOf(p);
      sumPred[b] += p;
      sumActual[b] += o;
      counts[b] += 1;
      samples++;
    }
  }

  const bins: CalibrationBin[] = [];
  for (let i = 0; i < BIN_COUNT; i++) {
    const lower = i * BIN_WIDTH;
    const upper = (i + 1) * BIN_WIDTH;
    const c = counts[i];
    bins.push({
      label: `${Math.round(lower * 100)}–${Math.round(upper * 100)}%`,
      lower,
      upper,
      count: c,
      avgPredicted: c ? sumPred[i] / c : 0,
      actualRate: c ? sumActual[i] / c : 0,
    });
  }

  return {
    total: graded,
    samples,
    brierScore: graded ? Math.round((brierSum / graded) * 10000) / 10000 : 0,
    baseline: 2 / 3,
    bins,
  };
}
