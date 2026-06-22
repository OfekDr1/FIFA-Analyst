import {
  Team,
  Match,
  MatchStats,
  MatchTeamResult,
  Scorer,
  UpcomingFixture,
} from "@/types";
import fs from "fs";
import path from "path";

// ═══════════════════════════════════════════════════════════════════
// football-data.org v4 (FREE TIER) integration layer
//
// Why this API: free tier, real REST schema, no RapidAPI middleman,
// and it covers the FIFA World Cup (competition code "WC").
// Auth is a single header: X-Auth-Token.
//
// Endpoints used (only 2 calls — well under the 10 req/min free limit):
//   GET /competitions/WC/teams    — all participating teams
//   GET /competitions/WC/matches  — fixtures + results + stage + group
//
// ⚠️  FREE-TIER DATA LIMITATION
//   football-data.org's free tier does NOT return per-match detailed
//   statistics (possession, shots, xG, passes, cards). Our Form Index
//   and Team Stats depend on those. To keep the UI functional we
//   DERIVE deterministic estimates from the scoreline (see
//   estimateMatchStats). These are NOT real measurements.
//
//   Flip STATS_ARE_ESTIMATED to false to get honest zeros instead.
//
//   Also: per-match scorer events are not in the free tier, so
//   per-match `scorers`/`assists` are left empty. The Tournament
//   Insights "Top Scorers" table will be empty until we wire the
//   separate GET /competitions/WC/scorers endpoint into stats.ts.
// ═══════════════════════════════════════════════════════════════════

const BASE_URL = "https://api.football-data.org/v4";
const COMPETITION = "WC"; // FIFA World Cup
const STATS_ARE_ESTIMATED = true;

const CACHE_FILE = path.join(process.cwd(), "local_data_cache.json");

// FIFA 3-letter code (tla) → emoji flag. football-data uses FIFA codes
// (GER, NED, POR…), which differ from ISO, so we map them explicitly.
const FLAG_EMOJI: Record<string, string> = {
  ARG: "🇦🇷", FRA: "🇫🇷", BRA: "🇧🇷", GER: "🇩🇪", ESP: "🇪🇸", JPN: "🇯🇵",
  MEX: "🇲🇽", KSA: "🇸🇦", USA: "🇺🇸", POR: "🇵🇹", NED: "🇳🇱", BEL: "🇧🇪",
  CRO: "🇭🇷", MAR: "🇲🇦", SEN: "🇸🇳", AUS: "🇦🇺", CAN: "🇨🇦", KOR: "🇰🇷",
  SUI: "🇨🇭", URU: "🇺🇾", COL: "🇨🇴", ITA: "🇮🇹", POL: "🇵🇱", DEN: "🇩🇰",
  SWE: "🇸🇪", ECU: "🇪🇨", QAT: "🇶🇦", IRN: "🇮🇷", SRB: "🇷🇸", CMR: "🇨🇲",
  GHA: "🇬🇭", TUN: "🇹🇳", NGA: "🇳🇬", CRC: "🇨🇷", PER: "🇵🇪", CHI: "🇨🇱",
  EGY: "🇪🇬", ENG: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", WAL: "🏴󠁧󠁢󠁷󠁬󠁳󠁿", SCO: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  PAR: "🇵🇾", VEN: "🇻🇪", BOL: "🇧🇴", JAM: "🇯🇲", PAN: "🇵🇦", HON: "🇭🇳",
  ALG: "🇩🇿", CIV: "🇨🇮", RSA: "🇿🇦", MLI: "🇲🇱", NOR: "🇳🇴", AUT: "🇦🇹",
  TUR: "🇹🇷", UKR: "🇺🇦", GRE: "🇬🇷", CZE: "🇨🇿", ROU: "🇷🇴", HUN: "🇭🇺",
  SVN: "🇸🇮", SVK: "🇸🇰", NZL: "🇳🇿", UZB: "🇺🇿", IRQ: "🇮🇶", UAE: "🇦🇪",
  JOR: "🇯🇴", OMA: "🇴🇲", CHN: "🇨🇳", IND: "🇮🇳", SCL: "🇸🇨",
};

function getFlag(tla: string | null): string {
  if (!tla) return "🏳️";
  return FLAG_EMOJI[tla.toUpperCase()] ?? "🏳️";
}

// ─── Raw football-data.org response types (partial) ──────────────

interface FdTeam {
  id: number;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
}

interface FdTeamsResponse {
  teams: FdTeam[];
}

interface FdScore {
  winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null;
  fullTime: { home: number | null; away: number | null };
  halfTime: { home: number | null; away: number | null };
}

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  stage: string;
  group: string | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score: FdScore;
}

interface FdMatchesResponse {
  matches: FdMatch[];
}

interface FdScorer {
  player: { id: number; name: string };
  team: { id: number; name: string };
  goals: number | null;
  assists: number | null;
  penalties: number | null;
}

interface FdScorersResponse {
  scorers: FdScorer[];
}

// ─── Local file cache (unchanged mechanism) ──────────────────────

interface CachedData {
  fetchedAt: string;
  teams: Team[];
  matches: Match[];
  scorers: Scorer[];
  upcoming: UpcomingFixture[];
}

function readCache(): CachedData | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data: CachedData = JSON.parse(raw);
    if (!Array.isArray(data.teams) || !Array.isArray(data.matches)) return null;
    // Older caches may predate these fields — normalize to arrays
    if (!Array.isArray(data.scorers)) data.scorers = [];
    if (!Array.isArray(data.upcoming)) data.upcoming = [];
    return data;
  } catch {
    return null;
  }
}

function writeCache(
  teams: Team[],
  matches: Match[],
  scorers: Scorer[],
  upcoming: UpcomingFixture[]
): void {
  const data: CachedData = {
    fetchedAt: new Date().toISOString(),
    teams,
    matches,
    scorers,
    upcoming,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
  console.log(
    `[api] Cache written: ${teams.length} teams, ${matches.length} matches, ${scorers.length} scorers, ${upcoming.length} upcoming → ${CACHE_FILE}`
  );
}

// ─── Fetch helper (football-data.org auth + error handling) ──────

async function apiFetch<T>(endpoint: string): Promise<T> {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FOOTBALL_DATA_API_KEY in environment variables");
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { "X-Auth-Token": apiKey },
    next: { revalidate: 300 },
  });

  // football-data returns proper HTTP codes (403 quota/plan, 429 rate
  // limit, 400 bad request) with a JSON { message, errorCode } body.
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errJson = await res.json();
      if (errJson?.message) detail = errJson.message;
    } catch {
      /* body wasn't JSON */
    }
    console.error(`[api] football-data ${res.status} on ${endpoint}: ${detail}`);
    throw new Error(`football-data ${res.status}: ${detail}`);
  }

  const remaining = res.headers.get("X-Requests-Available-Minute");
  if (remaining) {
    console.log(`[api] ${endpoint} — ${remaining} requests left this minute`);
  }

  return (await res.json()) as T;
}

// ─── Estimated stats (CLEARLY NOT REAL — derived from scoreline) ─

// possession is complementary, so it must be computed at match level
function estimateMatchStats(
  teamGoals: number,
  oppGoals: number,
  possession: number
): MatchStats {
  if (!STATS_ARE_ESTIMATED) {
    return {
      possession: 0, shotsTotal: 0, shotsOnTarget: 0, passes: 0,
      passAccuracy: 0, fouls: 0, corners: 0, offsides: 0,
      yellowCards: 0, redCards: 0, xG: 0,
    };
  }

  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

  const shotsOnTarget = clamp(Math.round(teamGoals * 1.6 + 2), 1, 12);
  const xG = Math.round((clamp(teamGoals * 0.8 + 0.45, 0.2, 4)) * 100) / 100;

  return {
    possession: Math.round(possession),
    shotsTotal: shotsOnTarget * 2 + 3,
    shotsOnTarget,
    passes: Math.round(possession * 9),
    passAccuracy: Math.round(clamp(70 + possession * 0.25, 70, 92)),
    fouls: clamp(10 + oppGoals, 6, 20),
    corners: clamp(Math.round(shotsOnTarget * 0.7), 1, 12),
    offsides: clamp(teamGoals, 0, 5),
    yellowCards: clamp(1 + (oppGoals > teamGoals ? 1 : 0), 0, 5),
    redCards: 0,
    xG,
  };
}

// ─── Mapping / Adapter functions ─────────────────────────────────

function mapTeam(raw: FdTeam): Team {
  return {
    id: String(raw.id),
    name: raw.shortName || raw.name,
    code: raw.tla ?? raw.name.slice(0, 3).toUpperCase(),
    group: "", // filled from match data afterwards
    flag: getFlag(raw.tla),
    crest: raw.crest ?? undefined, // real crest/flag image URL
  };
}

function mapStage(stage: string): Match["stage"] {
  switch (stage) {
    case "GROUP_STAGE":
      return "group";
    case "LAST_16":
      return "round-of-16";
    case "QUARTER_FINALS":
      return "quarter-final";
    case "SEMI_FINALS":
      return "semi-final";
    case "THIRD_PLACE":
    case "FINAL":
      return "final";
    default:
      return "group";
  }
}

function normalizeGroup(group: string | null): string {
  if (!group) return "";
  return group.replace(/^GROUP[_\s]?/i, "").trim();
}

function mapTeamResult(teamId: string, goals: number, stats: MatchStats): MatchTeamResult {
  return {
    teamId,
    goals,
    scorers: [], // per-match scorer events not in free tier
    assists: [],
    stats,
  };
}

function mapUpcoming(raw: FdMatch): UpcomingFixture {
  return {
    id: String(raw.id),
    date: raw.utcDate.split("T")[0],
    kickoff: raw.utcDate,
    stage: mapStage(raw.stage),
    group: normalizeGroup(raw.group),
    homeTeamId: String(raw.homeTeam.id),
    awayTeamId: String(raw.awayTeam.id),
  };
}

function mapScorer(raw: FdScorer): Scorer {
  return {
    player: raw.player.name,
    teamId: String(raw.team.id),
    goals: raw.goals ?? 0,
    assists: raw.assists ?? 0,
  };
}

function mapMatch(raw: FdMatch): Match {
  const homeGoals = raw.score.fullTime.home ?? 0;
  const awayGoals = raw.score.fullTime.away ?? 0;

  // Estimated possession is complementary and nudged by goal difference
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
  const homePossession = clamp(50 + (homeGoals - awayGoals) * 4, 35, 65);
  const awayPossession = 100 - homePossession;

  return {
    id: String(raw.id),
    date: raw.utcDate.split("T")[0],
    stage: mapStage(raw.stage),
    matchday: raw.matchday ?? 1,
    status: "Finished",
    home: mapTeamResult(
      String(raw.homeTeam.id),
      homeGoals,
      estimateMatchStats(homeGoals, awayGoals, homePossession)
    ),
    away: mapTeamResult(
      String(raw.awayTeam.id),
      awayGoals,
      estimateMatchStats(awayGoals, homeGoals, awayPossession)
    ),
  };
}

// ─── Fetch functions ─────────────────────────────────────────────

async function fetchWorldCupTeams(): Promise<Team[]> {
  const data = await apiFetch<FdTeamsResponse>(`/competitions/${COMPETITION}/teams`);
  if (!Array.isArray(data.teams) || data.teams.length === 0) {
    throw new Error("football-data returned no teams for the World Cup");
  }
  return data.teams.map(mapTeam);
}

// One call returns every fixture; we partition into finished results and
// upcoming (SCHEDULED/TIMED) fixtures, and derive groups from all of them.
async function fetchWorldCupMatches(): Promise<{
  matches: Match[];
  upcoming: UpcomingFixture[];
  groupMap: Map<string, string>;
}> {
  const data = await apiFetch<FdMatchesResponse>(
    `/competitions/${COMPETITION}/matches`
  );
  const all = data.matches ?? [];

  const finishedRaw = all.filter(
    (m) => m.status === "FINISHED" && m.score.fullTime.home !== null
  );
  if (finishedRaw.length === 0) {
    throw new Error("football-data returned no finished matches");
  }

  const upcomingRaw = all.filter(
    (m) => m.status === "SCHEDULED" || m.status === "TIMED"
  );

  // Groups are present on both finished and upcoming fixtures
  const groupMap = new Map<string, string>();
  for (const m of all) {
    const group = normalizeGroup(m.group);
    if (group) {
      groupMap.set(String(m.homeTeam.id), group);
      groupMap.set(String(m.awayTeam.id), group);
    }
  }

  const matches = finishedRaw
    .map(mapMatch)
    .sort((a, b) => a.date.localeCompare(b.date));

  const upcoming = upcomingRaw
    .map(mapUpcoming)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
    .slice(0, 16);

  return { matches, upcoming, groupMap };
}

// Top scorers + assists (one extra call). Resilient: if /scorers is gated
// or fails, we return [] so the rest of the dashboard still loads — the
// leaderboard simply falls back to per-match aggregation (empty on free tier).
async function fetchWorldCupScorers(): Promise<Scorer[]> {
  try {
    const data = await apiFetch<FdScorersResponse>(
      `/competitions/${COMPETITION}/scorers?limit=20`
    );
    if (!Array.isArray(data.scorers)) return [];
    return data.scorers.map(mapScorer);
  } catch (err) {
    console.warn(
      "[api] /scorers unavailable — Top Scorers leaderboard will be empty:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

// ─── Main entry point ────────────────────────────────────────────

export async function fetchDashboardData(): Promise<{
  teams: Team[];
  matches: Match[];
  scorers: Scorer[];
  upcoming: UpcomingFixture[];
}> {
  const isDev = process.env.NODE_ENV === "development";

  if (isDev) {
    const cached = readCache();
    if (cached) {
      console.log(
        `[api] Using cached data from ${cached.fetchedAt} (${cached.matches.length} matches, ${cached.upcoming.length} upcoming). Delete local_data_cache.json to refetch.`
      );
      return {
        teams: cached.teams,
        matches: cached.matches,
        scorers: cached.scorers,
        upcoming: cached.upcoming,
      };
    }
    console.log("[api] No cache found — fetching from football-data.org...");
  }

  // 3 network calls total — comfortably within the free tier.
  const [teams, { matches, upcoming, groupMap }, scorers] = await Promise.all([
    fetchWorldCupTeams(),
    fetchWorldCupMatches(),
    fetchWorldCupScorers(),
  ]);

  for (const team of teams) {
    team.group = groupMap.get(team.id) ?? "";
  }

  if (isDev) {
    writeCache(teams, matches, scorers, upcoming);
  }

  return { teams, matches, scorers, upcoming };
}
