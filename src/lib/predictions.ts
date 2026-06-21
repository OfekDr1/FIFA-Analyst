import { Match, Team } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// POISSON MATCH PREDICTION ENGINE
// ═══════════════════════════════════════════════════════════════════
//
// Uses each team's attacking/defensive strength relative to the
// tournament average to derive expected goals (lambda), then
// applies the Poisson distribution to compute:
//   - Expected goals for each team
//   - Win / Draw / Loss probabilities
//   - Most likely exact scorelines
//
// FORMULA:
//   attackStrength  = team's avg goals scored / tournament avg scored
//   defenseStrength = team's avg goals conceded / tournament avg conceded
//
//   λ_home = attackStrength_home × defenseStrength_away × tournamentAvgGoals × homeAdvantage
//   λ_away = attackStrength_away × defenseStrength_home × tournamentAvgGoals
//
//   P(home=x, away=y) = poisson(x, λ_home) × poisson(y, λ_away)
//
// HOME ADVANTAGE:
//   Neutral venue (World Cup) gets a mild 1.05× boost — much
//   lower than league football's ~1.3× because WC matches are
//   on neutral ground, but the "home" designee still picks side.
//
// MAX_GOALS:
//   We compute the probability grid up to 7 goals per side.
//   Matches with >7 goals for one team are astronomically rare.
// ═══════════════════════════════════════════════════════════════════

const HOME_ADVANTAGE = 1.05;
const MAX_GOALS = 7;

// ─── FIFA ranking grounding ──────────────────────────────────────
//
// The free API gives no FIFA ranking, and a 3-match sample over-fits
// badly (a team that bagged 4 early goals looks unstoppable). We
// hardcode approximate current FIFA ranking positions and use the
// relative gap between two teams to pull each side's expected goals
// back toward reality. A much lower-ranked side gets its λ penalised
// against a top-tier opponent.

const RANK_SCALE = 18; // larger ⇒ ranking gap matters less
const RANK_SENSITIVITY = 0.45; // max ± fraction applied to λ from ranking
const STRENGTH_PRIOR = 2.5; // shrink form strengths toward 1 (small-sample guard)
const DEFAULT_RANK = 50; // unranked / unknown teams

// Approximate current FIFA ranking positions for the top World Cup teams.
// Keyed by normalised team name; aliases included for API/mock variants.
const FIFA_RANKINGS: Record<string, number> = {
  argentina: 1,
  france: 2,
  spain: 3,
  england: 4,
  brazil: 5,
  portugal: 6,
  netherlands: 7,
  belgium: 8,
  italy: 9,
  germany: 10,
  croatia: 11,
  morocco: 12,
  colombia: 13,
  uruguay: 14,
  "united states": 15,
  usa: 15,
  mexico: 16,
  switzerland: 17,
  senegal: 18,
  japan: 19,
  denmark: 20,
  iran: 21,
  "ir iran": 21,
  "korea republic": 22,
  "south korea": 22,
  australia: 23,
  ecuador: 24,
  ukraine: 25,
  austria: 26,
  sweden: 27,
  turkiye: 28,
  turkey: 28,
  wales: 29,
  serbia: 30,
  poland: 31,
  egypt: 32,
  nigeria: 33,
  peru: 34,
  algeria: 35,
  scotland: 36,
  canada: 37,
  chile: 38,
  tunisia: 39,
  cameroon: 40,
  "saudi arabia": 41,
  ghana: 42,
  qatar: 43,
  "ivory coast": 44,
  "cote d'ivoire": 44,
  norway: 45,
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .trim();
}

function getFifaRank(team: Team): number {
  return FIFA_RANKINGS[normalizeName(team.name)] ?? DEFAULT_RANK;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface MatchPrediction {
  homeTeam: { id: string; name: string; flag: string; crest?: string };
  awayTeam: { id: string; name: string; flag: string; crest?: string };
  expectedGoals: { home: number; away: number };
  winProbability: { home: number; draw: number; away: number };
  mostLikelyScores: { home: number; away: number; probability: number }[];
  scoreGrid: number[][]; // [homeGoals][awayGoals] = probability
}

// ─── Poisson math ────────────────────────────────────────────────

function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function poisson(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

// ─── Team strength calculation ───────────────────────────────────

interface TeamStrength {
  teamId: string;
  avgScored: number;
  avgConceded: number;
  attackStrength: number;
  defenseStrength: number;
  matchesPlayed: number;
}

function calculateTeamStrengths(
  teams: Team[],
  matches: Match[]
): Map<string, TeamStrength> {
  const teamStats = new Map<
    string,
    { scored: number; conceded: number; played: number }
  >();

  for (const team of teams) {
    teamStats.set(team.id, { scored: 0, conceded: 0, played: 0 });
  }

  for (const match of matches) {
    const home = teamStats.get(match.home.teamId);
    const away = teamStats.get(match.away.teamId);
    if (home) {
      home.scored += match.home.goals;
      home.conceded += match.away.goals;
      home.played++;
    }
    if (away) {
      away.scored += match.away.goals;
      away.conceded += match.home.goals;
      away.played++;
    }
  }

  // Tournament averages (per match, per team)
  let totalScored = 0;
  let totalPlayed = 0;
  for (const s of teamStats.values()) {
    totalScored += s.scored;
    totalPlayed += s.played;
  }
  // Each goal is counted once for scorer and once for conceder,
  // so avg goals scored per team per match = totalScored / totalPlayed
  const avgScored = totalPlayed > 0 ? totalScored / totalPlayed : 1;
  const avgConceded = avgScored; // symmetric in aggregate

  const strengths = new Map<string, TeamStrength>();

  for (const team of teams) {
    const s = teamStats.get(team.id)!;
    if (s.played === 0) {
      strengths.set(team.id, {
        teamId: team.id,
        avgScored: avgScored,
        avgConceded: avgConceded,
        attackStrength: 1,
        defenseStrength: 1,
        matchesPlayed: 0,
      });
      continue;
    }

    const teamAvgScored = s.scored / s.played;
    const teamAvgConceded = s.conceded / s.played;

    strengths.set(team.id, {
      teamId: team.id,
      avgScored: teamAvgScored,
      avgConceded: teamAvgConceded,
      attackStrength: teamAvgScored / avgScored,
      defenseStrength: teamAvgConceded / avgConceded,
      matchesPlayed: s.played,
    });
  }

  return strengths;
}

// ─── Prediction ──────────────────────────────────────────────────

function buildScoreGrid(
  lambdaHome: number,
  lambdaAway: number
): number[][] {
  const grid: number[][] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    grid[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      grid[h][a] = poisson(h, lambdaHome) * poisson(a, lambdaAway);
    }
  }
  return grid;
}

export function predictMatch(
  homeTeam: Team,
  awayTeam: Team,
  teams: Team[],
  matches: Match[]
): MatchPrediction {
  const strengths = calculateTeamStrengths(teams, matches);
  const homeStr = strengths.get(homeTeam.id)!;
  const awayStr = strengths.get(awayTeam.id)!;

  // Tournament avg goals per team per match
  let totalGoals = 0;
  let totalTeamGames = 0;
  for (const s of strengths.values()) {
    totalGoals += s.avgScored * s.matchesPlayed;
    totalTeamGames += s.matchesPlayed;
  }
  const tournamentAvg = totalTeamGames > 0 ? totalGoals / totalTeamGames : 1.3;

  // ── Shrink form strengths toward 1 to curb small-sample overfitting ──
  const shrink = (s: TeamStrength) => {
    const w = s.matchesPlayed / (s.matchesPlayed + STRENGTH_PRIOR);
    return {
      attack: 1 + (s.attackStrength - 1) * w,
      defense: 1 + (s.defenseStrength - 1) * w,
    };
  };
  const h = shrink(homeStr);
  const a = shrink(awayStr);

  // ── FIFA ranking grounding: scale λ by the relative ranking gap ──
  const homeRank = getFifaRank(homeTeam);
  const awayRank = getFifaRank(awayTeam);
  // edge ∈ [-1, 1]; positive when home is the better-ranked (lower number) side
  const edge = Math.tanh((awayRank - homeRank) / RANK_SCALE);
  const homeRankMult = 1 + RANK_SENSITIVITY * edge;
  const awayRankMult = 1 - RANK_SENSITIVITY * edge;

  // Expected goals — form × opponent defense × tournament baseline × ranking
  const lambdaHome = clamp(
    h.attack * a.defense * tournamentAvg * HOME_ADVANTAGE * homeRankMult,
    0.15,
    4.5
  );
  const lambdaAway = clamp(
    a.attack * h.defense * tournamentAvg * awayRankMult,
    0.15,
    4.5
  );

  const grid = buildScoreGrid(lambdaHome, lambdaAway);

  // Win/draw/loss probabilities
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      if (h > a) homeWin += grid[h][a];
      else if (h === a) draw += grid[h][a];
      else awayWin += grid[h][a];
    }
  }

  // Normalize (grid doesn't sum to exactly 1 due to MAX_GOALS cutoff)
  const total = homeWin + draw + awayWin;
  homeWin /= total;
  draw /= total;
  awayWin /= total;

  // Top scorelines
  const scorelines: { home: number; away: number; probability: number }[] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      scorelines.push({ home: h, away: a, probability: grid[h][a] / total });
    }
  }
  scorelines.sort((a, b) => b.probability - a.probability);

  return {
    homeTeam: {
      id: homeTeam.id,
      name: homeTeam.name,
      flag: homeTeam.flag,
      crest: homeTeam.crest,
    },
    awayTeam: {
      id: awayTeam.id,
      name: awayTeam.name,
      flag: awayTeam.flag,
      crest: awayTeam.crest,
    },
    expectedGoals: {
      home: Math.round(lambdaHome * 100) / 100,
      away: Math.round(lambdaAway * 100) / 100,
    },
    winProbability: {
      home: Math.round(homeWin * 1000) / 10,
      draw: Math.round(draw * 1000) / 10,
      away: Math.round(awayWin * 1000) / 10,
    },
    mostLikelyScores: scorelines.slice(0, 6),
    scoreGrid: grid.map((row) => row.map((v) => Math.round((v / total) * 10000) / 100)),
  };
}

// ─── Batch: predict all possible matchups ────────────────────────

export function predictAllMatchups(
  teams: Team[],
  matches: Match[]
): MatchPrediction[] {
  const predictions: MatchPrediction[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      predictions.push(predictMatch(teams[i], teams[j], teams, matches));
    }
  }
  return predictions;
}
