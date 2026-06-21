import { Match, Team, FormIndexResult } from "../types";

// ═══════════════════════════════════════════════════════════════════
// FORM INDEX ALGORITHM (v2 — with Opponent Strength Adjustment)
// ═══════════════════════════════════════════════════════════════════
//
// PHASE 1: Compute a raw 0–100 score per team from six sub-scores.
// PHASE 2: Re-weight each match by opponent raw score, then
//          recalculate. Beating a strong team inflates your score;
//          beating a weak team deflates it.
//
// SUB-SCORE WEIGHTS:
//   Points earned ........... 35%
//   Goal difference ......... 20%
//   xG performance .......... 20%
//   Possession .............. 10%
//   Shots on target ......... 10%
//   Clean sheets ............ 5%
//
// OPPONENT STRENGTH MULTIPLIER:
//   multiplier = 0.7 + 0.6 × (opponentRawScore / 100)
//   Range: 0.7 (opponent scored 0) → 1.3 (opponent scored 100)
//   This is applied as an additional per-match weight on top of
//   recency decay, so beating France (raw ~80) counts ~1.18×
//   while beating Saudi Arabia (raw ~30) counts ~0.88×.
//
// ═══════════════════════════════════════════════════════════════════

const WEIGHTS = {
  points: 0.35,
  goalDifference: 0.20,
  xgPerformance: 0.20,
  possession: 0.10,
  shotsOnTarget: 0.10,
  cleanSheets: 0.05,
};

const RECENCY_DECAY = 0.8;
const OPP_STRENGTH_MIN = 0.7;
const OPP_STRENGTH_RANGE = 0.6;

interface TeamMatchData {
  opponentId: string;
  goalsScored: number;
  goalsConceded: number;
  possession: number;
  shotsOnTarget: number;
  xG: number;
  xGConceded: number;
  points: number;
  date: string;
}

function getTeamMatches(teamId: string, matches: Match[]): TeamMatchData[] {
  const teamMatches: TeamMatchData[] = [];

  for (const match of matches) {
    const isHome = match.home.teamId === teamId;
    const isAway = match.away.teamId === teamId;
    if (!isHome && !isAway) continue;

    const team = isHome ? match.home : match.away;
    const opponent = isHome ? match.away : match.home;

    let points = 0;
    if (team.goals > opponent.goals) points = 3;
    else if (team.goals === opponent.goals) points = 1;

    teamMatches.push({
      opponentId: opponent.teamId,
      goalsScored: team.goals,
      goalsConceded: opponent.goals,
      possession: team.stats.possession,
      shotsOnTarget: team.stats.shotsOnTarget,
      xG: team.stats.xG,
      xGConceded: opponent.stats.xG,
      points,
      date: match.date,
    });
  }

  teamMatches.sort((a, b) => a.date.localeCompare(b.date));
  return teamMatches;
}

function recencyWeights(count: number): number[] {
  const weights: number[] = [];
  for (let i = 0; i < count; i++) {
    weights.push(Math.pow(RECENCY_DECAY, count - 1 - i));
  }
  return weights;
}

function weightedAvg(values: number[], weights: number[]): number {
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return 0;
  return values.reduce((s, v, i) => s + v * weights[i], 0) / totalWeight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function calcPointsScore(data: TeamMatchData[], weights: number[]): number {
  const perMatch = data.map((d) => (d.points / 3) * 100);
  return weightedAvg(perMatch, weights);
}

function calcGoalDiffScore(data: TeamMatchData[], weights: number[]): number {
  const perMatch = data.map((d) => {
    const gd = clamp(d.goalsScored - d.goalsConceded, -3, 3);
    return ((gd + 3) / 6) * 100;
  });
  return weightedAvg(perMatch, weights);
}

function calcXGScore(data: TeamMatchData[], weights: number[]): number {
  const perMatch = data.map((d) => {
    const offensiveOverperformance = d.goalsScored - d.xG;
    const defensiveOverperformance = d.xGConceded - d.goalsConceded;
    const combined = clamp(offensiveOverperformance + defensiveOverperformance, -2, 2);
    return ((combined + 2) / 4) * 100;
  });
  return weightedAvg(perMatch, weights);
}

function calcPossessionScore(data: TeamMatchData[], weights: number[]): number {
  const perMatch = data.map((d) => clamp(d.possession, 25, 75));
  const avg = weightedAvg(perMatch, weights);
  return ((avg - 25) / 50) * 100;
}

function calcShotsScore(data: TeamMatchData[], weights: number[]): number {
  const perMatch = data.map((d) => clamp(d.shotsOnTarget / 10, 0, 1) * 100);
  return weightedAvg(perMatch, weights);
}

function calcCleanSheetScore(data: TeamMatchData[]): number {
  if (data.length === 0) return 0;
  const cleanSheets = data.filter((d) => d.goalsConceded === 0).length;
  return (cleanSheets / data.length) * 100;
}

function computeRawScore(data: TeamMatchData[], weights: number[]) {
  const breakdown = {
    points: Math.round(calcPointsScore(data, weights) * 10) / 10,
    goalDifference: Math.round(calcGoalDiffScore(data, weights) * 10) / 10,
    xgPerformance: Math.round(calcXGScore(data, weights) * 10) / 10,
    possession: Math.round(calcPossessionScore(data, weights) * 10) / 10,
    shotsOnTarget: Math.round(calcShotsScore(data, weights) * 10) / 10,
    cleanSheets: Math.round(calcCleanSheetScore(data) * 10) / 10,
  };

  const overall =
    breakdown.points * WEIGHTS.points +
    breakdown.goalDifference * WEIGHTS.goalDifference +
    breakdown.xgPerformance * WEIGHTS.xgPerformance +
    breakdown.possession * WEIGHTS.possession +
    breakdown.shotsOnTarget * WEIGHTS.shotsOnTarget +
    breakdown.cleanSheets * WEIGHTS.cleanSheets;

  return { breakdown, overall };
}

function opponentMultiplier(opponentRawScore: number): number {
  return OPP_STRENGTH_MIN + OPP_STRENGTH_RANGE * (opponentRawScore / 100);
}

export function calculateFormIndex(
  teams: Team[],
  matches: Match[]
): FormIndexResult[] {
  // ── Phase 1: raw scores (no opponent adjustment) ──
  const teamDataMap = new Map<string, TeamMatchData[]>();
  const rawScores = new Map<string, number>();

  for (const team of teams) {
    const data = getTeamMatches(team.id, matches);
    teamDataMap.set(team.id, data);
    if (data.length === 0) {
      rawScores.set(team.id, 0);
      continue;
    }
    const weights = recencyWeights(data.length);
    const { overall } = computeRawScore(data, weights);
    rawScores.set(team.id, overall);
  }

  // ── Phase 2: recalculate with opponent-strength-adjusted weights ──
  const results: FormIndexResult[] = [];

  for (const team of teams) {
    const data = teamDataMap.get(team.id)!;
    if (data.length === 0) continue;

    const baseWeights = recencyWeights(data.length);

    // Multiply each match's recency weight by the opponent strength factor
    const adjustedWeights = data.map((d, i) => {
      const oppRaw = rawScores.get(d.opponentId) ?? 50;
      return baseWeights[i] * opponentMultiplier(oppRaw);
    });

    const { breakdown } = computeRawScore(data, adjustedWeights);

    const overall =
      breakdown.points * WEIGHTS.points +
      breakdown.goalDifference * WEIGHTS.goalDifference +
      breakdown.xgPerformance * WEIGHTS.xgPerformance +
      breakdown.possession * WEIGHTS.possession +
      breakdown.shotsOnTarget * WEIGHTS.shotsOnTarget +
      breakdown.cleanSheets * WEIGHTS.cleanSheets;

    const trend = data.map((d) => {
      const pts = (d.points / 3) * 100;
      const gd = ((clamp(d.goalsScored - d.goalsConceded, -3, 3) + 3) / 6) * 100;
      const poss = ((clamp(d.possession, 25, 75) - 25) / 50) * 100;
      return Math.round(pts * 0.5 + gd * 0.3 + poss * 0.2);
    });

    const wins = data.filter((d) => d.points === 3).length;
    const draws = data.filter((d) => d.points === 1).length;
    const losses = data.filter((d) => d.points === 0).length;

    results.push({
      teamId: team.id,
      teamName: team.name,
      flag: team.flag,
      crest: team.crest,
      overall: Math.round(overall * 10) / 10,
      breakdown,
      trend,
      played: data.length,
      wins,
      draws,
      losses,
    });
  }

  results.sort((a, b) => b.overall - a.overall);
  return results;
}
