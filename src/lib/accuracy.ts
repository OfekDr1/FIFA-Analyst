import { Match, Team } from "@/types";
import { predictMatch } from "@/lib/predictions";

// ═══════════════════════════════════════════════════════════════════
// PREDICTION ACCURACY TRACKER
// ═══════════════════════════════════════════════════════════════════
//
// For each FINISHED match we ask: what would the Poisson engine have
// predicted *before kickoff*? To keep it honest (no leakage), the
// prediction for a given match is generated using only matches that
// finished strictly BEFORE it. Then we grade the most-likely scoreline:
//
//   • Exact  — predicted scoreline === actual scoreline
//   • Trend  — correct 1X2 result (winner or draw), but not exact
//   • Miss   — wrong result
//
// Note: "exact" implies a correct trend, so trendAccuracy counts exacts
// too (standard 1X2 convention).
// ═══════════════════════════════════════════════════════════════════

export type PredictionOutcome = "exact" | "trend" | "miss";

export interface ScoreLine {
  home: number;
  away: number;
}

export interface MatchPredictionReview {
  matchId: string;
  date: string;
  stage: Match["stage"];
  home: { id: string; name: string; flag: string; crest?: string };
  away: { id: string; name: string; flag: string; crest?: string };
  predicted: ScoreLine;
  actual: ScoreLine;
  outcome: PredictionOutcome;
}

export interface AccuracyStats {
  total: number;
  exactCount: number;
  trendCount: number; // correct 1X2 (includes exact)
  exactAccuracy: number; // percentage, 1 decimal
  trendAccuracy: number; // percentage, 1 decimal
  reviews: MatchPredictionReview[];
}

function result1x2(s: ScoreLine): "H" | "D" | "A" {
  if (s.home > s.away) return "H";
  if (s.home < s.away) return "A";
  return "D";
}

function isFinished(m: Match): boolean {
  // Our stored matches are finished; treat a missing status as Finished.
  return m.status === undefined || m.status === "Finished";
}

export function evaluatePredictions(
  teams: Team[],
  matches: Match[]
): AccuracyStats {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const finished = matches.filter(isFinished);

  const reviews: MatchPredictionReview[] = [];
  let exactCount = 0;
  let trendCount = 0;

  for (const match of finished) {
    const homeTeam = teamById.get(match.home.teamId);
    const awayTeam = teamById.get(match.away.teamId);
    if (!homeTeam || !awayTeam) continue;

    // Only data available before this match — no leakage of its own result.
    const priorMatches = finished.filter((m) => m.date < match.date);

    // Grade the xG-blended Poisson model (applyXG) but drop the temporary
    // Elo/momentum modifiers, which reflect *current* form and weren't
    // knowable pre-kickoff — including them would leak future info.
    const prediction = predictMatch(homeTeam, awayTeam, teams, priorMatches, {
      applyModifiers: false,
      applyXG: true,
    });
    const top = prediction.mostLikelyScores[0];
    if (!top) continue;

    const predicted: ScoreLine = { home: top.home, away: top.away };
    const actual: ScoreLine = { home: match.home.goals, away: match.away.goals };

    const exact = predicted.home === actual.home && predicted.away === actual.away;
    const trend = result1x2(predicted) === result1x2(actual);

    let outcome: PredictionOutcome = "miss";
    if (exact) outcome = "exact";
    else if (trend) outcome = "trend";

    if (exact) exactCount++;
    if (trend) trendCount++; // exact counts as a correct trend too

    reviews.push({
      matchId: match.id,
      date: match.date,
      stage: match.stage,
      home: { id: homeTeam.id, name: homeTeam.name, flag: homeTeam.flag, crest: homeTeam.crest },
      away: { id: awayTeam.id, name: awayTeam.name, flag: awayTeam.flag, crest: awayTeam.crest },
      predicted,
      actual,
      outcome,
    });
  }

  // Newest first
  reviews.sort(
    (a, b) => b.date.localeCompare(a.date) || b.matchId.localeCompare(a.matchId)
  );

  const total = reviews.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

  return {
    total,
    exactCount,
    trendCount,
    exactAccuracy: pct(exactCount),
    trendAccuracy: pct(trendCount),
    reviews,
  };
}
