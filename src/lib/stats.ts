import { Match, Team, TeamAverages, TournamentInsights, Scorer } from "../types";

export function calculateTeamAverages(
  teamId: string,
  team: Team,
  matches: Match[]
): TeamAverages {
  const teamMatches: { team: Match["home"]; opponent: Match["home"] }[] = [];

  for (const match of matches) {
    if (match.home.teamId === teamId) {
      teamMatches.push({ team: match.home, opponent: match.away });
    } else if (match.away.teamId === teamId) {
      teamMatches.push({ team: match.away, opponent: match.home });
    }
  }

  const n = teamMatches.length;
  if (n === 0) {
    return {
      teamId,
      teamName: team.name,
      flag: team.flag,
      crest: team.crest,
      played: 0,
      avgGoalsScored: 0,
      avgGoalsConceded: 0,
      avgPossession: 0,
      avgShotsOnTarget: 0,
      avgPasses: 0,
      avgPassAccuracy: 0,
      avgXG: 0,
      avgYellowCards: 0,
      avgRedCards: 0,
      avgCorners: 0,
      totalGoals: 0,
      totalYellowCards: 0,
      totalRedCards: 0,
    };
  }

  const sum = (fn: (m: (typeof teamMatches)[0]) => number) =>
    teamMatches.reduce((s, m) => s + fn(m), 0);

  const round2 = (v: number) => Math.round(v * 100) / 100;

  const totalGoals = sum((m) => m.team.goals);
  const totalYellow = sum((m) => m.team.stats.yellowCards);
  const totalRed = sum((m) => m.team.stats.redCards);

  return {
    teamId,
    teamName: team.name,
    flag: team.flag,
    crest: team.crest,
    played: n,
    avgGoalsScored: round2(totalGoals / n),
    avgGoalsConceded: round2(sum((m) => m.opponent.goals) / n),
    avgPossession: round2(sum((m) => m.team.stats.possession) / n),
    avgShotsOnTarget: round2(sum((m) => m.team.stats.shotsOnTarget) / n),
    avgPasses: round2(sum((m) => m.team.stats.passes) / n),
    avgPassAccuracy: round2(sum((m) => m.team.stats.passAccuracy) / n),
    avgXG: round2(sum((m) => m.team.stats.xG) / n),
    avgYellowCards: round2(totalYellow / n),
    avgRedCards: round2(totalRed / n),
    avgCorners: round2(sum((m) => m.team.stats.corners) / n),
    totalGoals,
    totalYellowCards: totalYellow,
    totalRedCards: totalRed,
  };
}

export function calculateAllTeamAverages(
  teams: Team[],
  matches: Match[]
): TeamAverages[] {
  return teams.map((t) => calculateTeamAverages(t.id, t, matches));
}

export function calculateTournamentInsights(
  teams: Team[],
  matches: Match[],
  scorers?: Scorer[]
): TournamentInsights {
  const totalMatches = matches.length;
  const totalGoals = matches.reduce(
    (s, m) => s + m.home.goals + m.away.goals,
    0
  );
  const totalYellowCards = matches.reduce(
    (s, m) => s + m.home.stats.yellowCards + m.away.stats.yellowCards,
    0
  );
  const totalRedCards = matches.reduce(
    (s, m) => s + m.home.stats.redCards + m.away.stats.redCards,
    0
  );

  // Most common results
  const resultCounts = new Map<string, number>();
  for (const match of matches) {
    const home = match.home.goals;
    const away = match.away.goals;
    // Normalize: always show higher score first for non-draws
    const key =
      home >= away ? `${home}-${away}` : `${away}-${home}`;
    resultCounts.set(key, (resultCounts.get(key) || 0) + 1);
  }
  const mostCommonResults = [...resultCounts.entries()]
    .map(([result, count]) => ({ result, count }))
    .sort((a, b) => b.count - a.count);

  // Top scorers
  const scorerMap = new Map<string, { teamId: string; goals: number }>();
  for (const match of matches) {
    for (const side of [match.home, match.away]) {
      for (const scorer of side.scorers) {
        const key = `${scorer.player}|${side.teamId}`;
        const existing = scorerMap.get(key);
        if (existing) {
          existing.goals++;
        } else {
          scorerMap.set(key, { teamId: side.teamId, goals: 1 });
        }
      }
    }
  }
  const topScorersFromMatches = [...scorerMap.entries()]
    .map(([key, val]) => ({
      player: key.split("|")[0],
      teamId: val.teamId,
      goals: val.goals,
    }))
    .sort((a, b) => b.goals - a.goals)
    .slice(0, 10);

  // Top assisters
  const assistMap = new Map<string, { teamId: string; assists: number }>();
  for (const match of matches) {
    for (const side of [match.home, match.away]) {
      for (const assist of side.assists) {
        const key = `${assist.player}|${side.teamId}`;
        const existing = assistMap.get(key);
        if (existing) {
          existing.assists++;
        } else {
          assistMap.set(key, { teamId: side.teamId, assists: 1 });
        }
      }
    }
  }
  const topAssistersFromMatches = [...assistMap.entries()]
    .map(([key, val]) => ({
      player: key.split("|")[0],
      teamId: val.teamId,
      assists: val.assists,
    }))
    .sort((a, b) => b.assists - a.assists)
    .slice(0, 10);

  // Prefer real scorer data (from football-data.org /scorers) when supplied;
  // otherwise fall back to aggregating per-match events (used by mock data).
  const hasRealScorers = Array.isArray(scorers) && scorers.length > 0;

  const topScorers = hasRealScorers
    ? [...scorers]
        .sort((a, b) => b.goals - a.goals)
        .slice(0, 10)
        .map((s) => ({ player: s.player, teamId: s.teamId, goals: s.goals }))
    : topScorersFromMatches;

  const topAssisters = hasRealScorers
    ? [...scorers]
        .filter((s) => s.assists > 0)
        .sort((a, b) => b.assists - a.assists)
        .slice(0, 10)
        .map((s) => ({ player: s.player, teamId: s.teamId, assists: s.assists }))
    : topAssistersFromMatches;

  return {
    totalMatches,
    totalGoals,
    avgGoalsPerMatch: Math.round((totalGoals / totalMatches) * 100) / 100,
    totalYellowCards,
    totalRedCards,
    mostCommonResults,
    topScorers,
    topAssisters,
  };
}
