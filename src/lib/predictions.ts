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

// ─── Real-world momentum injection (public/team_momentum.json) ────
//
// momentum_score ∈ [0, 100] per team, from recent competitive form.
// Loaded once at runtime via fetch (resilient: a missing/invalid file
// just leaves everyone at the neutral default). Keyed by normalised
// team name; unknown teams default to 50.
//
// The home/away momentum GAP becomes a multiplier on each side's λ,
// self-capped to ±MAX_MOMENTUM_IMPACT via tanh.

const DEFAULT_MOMENTUM = 50;
const MAX_MOMENTUM_IMPACT = 0.2; // hard cap: ≤ 20% swing on λ
const MOMENTUM_SCALE = 40; // point-gap that drives tanh toward the cap

// ─── World Football Elo grounding ────────────────────────────────
// Elo expected win probability gives a second, well-calibrated signal.
// Gated behind the SAME applyMomentum flag so historical accuracy runs
// (applyMomentum: false) don't leak current Elo onto past matches.
const DEFAULT_ELO = 1500; // baseline for teams missing an Elo rating
const MAX_ELO_IMPACT = 0.25; // hard cap: ≤ 25% swing on λ from Elo edge

// ─── Underlying xG quality ───────────────────────────────────────
// xG_per_90 / xGA_per_90 are blended 50/50 with historical goal rates
// to form the BASE Poisson λ, regularising small-sample overconfidence.
const DEFAULT_XG = 1.1; // tournament-baseline xG / xGA per 90

interface MomentumEntry {
  team: string;
  momentum_score: number;
  elo?: number;
  xG_per_90?: number;
  xGA_per_90?: number;
}

const momentumByName = new Map<string, number>();
const eloByName = new Map<string, number>();
const xgByName = new Map<string, { xg: number; xga: number }>();
let momentumLoaded = false;
let momentumLoading: Promise<void> | null = null;

// ─── Learned 1X2 model (multinomial logistic regression) — Option A ──
// Coefficients trained in Python (compute_momentum.py) and applied here
// as softmax(W·x + b). Replaces the hardcoded heuristic for live win
// probabilities; null until loaded.
interface MLModel {
  type?: string;
  features: string[];
  means: number[];
  stds: number[];
  classes: string[]; // e.g. ["A", "D", "H"]
  coef: number[][]; // [class][feature]
  intercept: number[]; // [class]
  metrics?: {
    test_matches?: number;
    accuracy?: number;
    log_loss?: number;
    brier?: number;
    baseline_brier?: number;
  };
}
let mlModel: MLModel | null = null;

export interface ModelInfo {
  active: boolean;
  type?: string;
  brier?: number;
  baselineBrier?: number;
  accuracy?: number;
  testMatches?: number;
}

/** UI accessor: is the learned model live, and how did it test? */
export function getModelInfo(): ModelInfo {
  const m = mlModel;
  if (!m) return { active: false };
  return {
    active: true,
    type: m.type,
    brier: m.metrics?.brier,
    baselineBrier: m.metrics?.baseline_brier,
    accuracy: m.metrics?.accuracy,
    testMatches: m.metrics?.test_matches,
  };
}

function isValidModel(m: unknown): m is MLModel {
  if (!m || typeof m !== "object") return false;
  const x = m as MLModel;
  return (
    Array.isArray(x.features) &&
    Array.isArray(x.classes) &&
    Array.isArray(x.coef) &&
    Array.isArray(x.intercept) &&
    Array.isArray(x.means) &&
    Array.isArray(x.stds) &&
    x.coef.length === x.classes.length &&
    x.intercept.length === x.classes.length
  );
}

/**
 * Fetch and register the momentum scores. Idempotent and safe to call
 * from any client component. Resolves once loaded (or once it has
 * decided the file is unavailable). Call this, then recompute
 * predictions, so the scores actually feed into λ.
 */
export function loadMomentumScores(): Promise<void> {
  if (momentumLoaded) return Promise.resolve();
  if (momentumLoading) return momentumLoading;

  momentumLoading = fetch(`/team_momentum.json?t=${new Date().getTime()}`, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : { teams: [] }))
    .then((data: { teams?: MomentumEntry[]; model?: unknown }) => {
      for (const e of data.teams ?? []) {
        if (!e || typeof e.team !== "string") continue;
        const key = normalizeName(e.team);
        if (typeof e.momentum_score === "number") {
          momentumByName.set(key, e.momentum_score);
        }
        if (typeof e.elo === "number") {
          eloByName.set(key, e.elo);
        }
        if (typeof e.xG_per_90 === "number" || typeof e.xGA_per_90 === "number") {
          xgByName.set(key, {
            xg: typeof e.xG_per_90 === "number" ? e.xG_per_90 : DEFAULT_XG,
            xga: typeof e.xGA_per_90 === "number" ? e.xGA_per_90 : DEFAULT_XG,
          });
        }
      }
      mlModel = isValidModel(data.model) ? data.model : null;
      momentumLoaded = true;
    })
    .catch(() => {
      // Missing/invalid file → everyone defaults to 50; predictions still work.
      momentumLoaded = true;
    });

  return momentumLoading;
}

/** Public accessor for the UI — returns a team's momentum (default 50). */
export function getMomentumScore(teamName: string): number {
  return momentumByName.get(normalizeName(teamName)) ?? DEFAULT_MOMENTUM;
}

function getMomentum(team: Team): number {
  return getMomentumScore(team.name);
}

/** Public accessor for the UI — returns a team's Elo (default 1500). */
export function getEloRating(teamName: string): number {
  return eloByName.get(normalizeName(teamName)) ?? DEFAULT_ELO;
}

function getElo(team: Team): number {
  return getEloRating(team.name);
}

/** Public accessor for the UI — returns a team's xG/xGA per 90 (default 1.10). */
export function getTeamXg(teamName: string): { xg: number; xga: number } {
  return xgByName.get(normalizeName(teamName)) ?? { xg: DEFAULT_XG, xga: DEFAULT_XG };
}

function getXg(team: Team): { xg: number; xga: number } {
  return getTeamXg(team.name);
}

// Home-minus-Away feature differences — must match the Python feature defs.
function mlFeatureValue(name: string, homeTeam: Team, awayTeam: Team): number {
  const hx = getTeamXg(homeTeam.name);
  const ax = getTeamXg(awayTeam.name);
  switch (name) {
    case "elo_diff":
      return getEloRating(homeTeam.name) - getEloRating(awayTeam.name);
    case "momentum_diff":
      return getMomentumScore(homeTeam.name) - getMomentumScore(awayTeam.name);
    case "xg_diff":
      return hx.xg - ax.xg;
    case "xga_diff":
      return hx.xga - ax.xga;
    default:
      return 0;
  }
}

/**
 * 1X2 win probabilities from the learned logistic-regression model:
 * softmax(W·x_standardised + b). Returns null if no model is loaded so
 * callers can fall back to the Poisson split.
 */
export function getOutcomeProbabilities(
  homeTeam: Team,
  awayTeam: Team
): { home: number; draw: number; away: number } | null {
  const m = mlModel;
  if (!m) return null;

  // Standardise features in the model's own feature order.
  const x = m.features.map((f, j) => {
    const raw = mlFeatureValue(f, homeTeam, awayTeam);
    const std = m.stds[j] || 1;
    return (raw - (m.means[j] ?? 0)) / std;
  });

  // Per-class logit, then numerically-stable softmax.
  const logits = m.classes.map(
    (_, k) => m.intercept[k] + x.reduce((s, xj, j) => s + (m.coef[k][j] ?? 0) * xj, 0)
  );
  const maxL = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxL));
  const sum = exps.reduce((acc, v) => acc + v, 0) || 1;

  const out = { home: 0, draw: 0, away: 0 };
  m.classes.forEach((c, k) => {
    const p = exps[k] / sum;
    if (c === "H") out.home = p;
    else if (c === "D") out.draw = p;
    else if (c === "A") out.away = p;
  });
  return out;
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
  matches: Match[],
  options: { applyModifiers?: boolean; applyXG?: boolean } = {}
): MatchPrediction {
  // applyModifiers → momentum + Elo (temporary current-form signals)
  // applyXG        → blend the underlying xG quality into the base λ
  const { applyModifiers = true, applyXG = true } = options;
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

  // ── Base λ from team attack/defense rates ──
  // The xG blend is gated independently by applyXG:
  //   • applyXG = true  → blend historical goals 50/50 with xG
  //     (regularises small-sample overconfidence on weak teams)
  //   • applyXG = false → pure historical goals scored/conceded
  const safeAvg = tournamentAvg > 0 ? tournamentAvg : 1.3;
  const homeXg = getXg(homeTeam);
  const awayXg = getXg(awayTeam);
  const blend = (hist: number, xg: number) =>
    applyXG ? 0.5 * hist + 0.5 * xg : hist;

  const homeAttack = blend(homeStr.avgScored, homeXg.xg);
  const homeDefense = blend(homeStr.avgConceded, homeXg.xga);
  const awayAttack = blend(awayStr.avgScored, awayXg.xg);
  const awayDefense = blend(awayStr.avgConceded, awayXg.xga);

  // Dixon-Coles base: λ = teamAttack × oppDefense / leagueAvg
  const baseHomeLambda = ((homeAttack * awayDefense) / safeAvg) * HOME_ADVANTAGE;
  const baseAwayLambda = (awayAttack * homeDefense) / safeAvg;

  // ── FIFA ranking grounding: scale λ by the relative ranking gap ──
  const homeRank = getFifaRank(homeTeam);
  const awayRank = getFifaRank(awayTeam);
  // edge ∈ [-1, 1]; positive when home is the better-ranked (lower number) side
  const edge = Math.tanh((awayRank - homeRank) / RANK_SCALE);
  const homeRankMult = 1 + RANK_SENSITIVITY * edge;
  const awayRankMult = 1 - RANK_SENSITIVITY * edge;

  // ── Current-form modifiers (momentum + Elo), gated by applyModifiers ──
  // Both reflect *present-day* form, so historical evaluation runs
  // (applyModifiers: false) skip them to avoid data leakage.
  let momentumModifier = 0;
  let eloModifier = 0;
  if (applyModifiers) {
    // Recent competitive form — nudge λ by the momentum gap (±20% cap)
    const momentumGap = getMomentum(homeTeam) - getMomentum(awayTeam); // -100 … +100
    momentumModifier = MAX_MOMENTUM_IMPACT * Math.tanh(momentumGap / MOMENTUM_SCALE);

    // World Football Elo — expected win probability via the standard formula
    const homeElo = getElo(homeTeam);
    const awayElo = getElo(awayTeam);
    const eloProbHome = 1 / (1 + Math.pow(10, (awayElo - homeElo) / 400));
    // Map probability (0.5 = even) to a [-1, 1] edge, then cap the swing.
    const eloEdge = 2 * eloProbHome - 1;
    eloModifier = MAX_ELO_IMPACT * eloEdge;
  }
  const homeMomentumMult = 1 + momentumModifier; // hotter side: λ up
  const awayMomentumMult = 1 - momentumModifier; // colder side: λ down
  const homeEloMult = 1 + eloModifier; // Elo-favoured side: λ up
  const awayEloMult = 1 - eloModifier;

  // Final λ = xG-blended base × FIFA ranking × momentum × Elo
  const lambdaHome = clamp(
    baseHomeLambda * homeRankMult * homeMomentumMult * homeEloMult,
    0.15,
    4.5
  );
  const lambdaAway = clamp(
    baseAwayLambda * awayRankMult * awayMomentumMult * awayEloMult,
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

  // ── Headline 1X2: prefer the learned ML model (live mode) ──
  // The Poisson grid still drives expected goals + the scoreline heatmap,
  // but the win/draw/away probabilities come from the trained model when
  // available. Gated by applyModifiers so the leak-free historical
  // evaluation keeps using the pure Poisson split.
  let pHome = homeWin;
  let pDraw = draw;
  let pAway = awayWin;
  if (applyModifiers) {
    const ml = getOutcomeProbabilities(homeTeam, awayTeam);
    if (ml) {
      pHome = ml.home;
      pDraw = ml.draw;
      pAway = ml.away;
    }
  }

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
      home: Math.round(pHome * 1000) / 10,
      draw: Math.round(pDraw * 1000) / 10,
      away: Math.round(pAway * 1000) / 10,
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
