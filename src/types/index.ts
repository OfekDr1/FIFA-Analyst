export interface Team {
  id: string;
  name: string;
  code: string; // FIFA 3-letter code
  group: string;
  flag: string; // emoji flag (fallback)
  crest?: string; // crest/flag image URL from the API
}

export interface MatchStats {
  possession: number; // percentage 0-100
  shotsTotal: number;
  shotsOnTarget: number;
  passes: number;
  passAccuracy: number; // percentage
  fouls: number;
  corners: number;
  offsides: number;
  yellowCards: number;
  redCards: number;
  xG: number; // Expected Goals
}

export interface MatchTeamResult {
  teamId: string;
  goals: number;
  scorers: { player: string; minute: number }[];
  assists: { player: string; minute: number }[];
  stats: MatchStats;
}

export interface Match {
  id: string;
  date: string; // ISO date
  stage: "group" | "round-of-16" | "quarter-final" | "semi-final" | "final";
  matchday: number;
  home: MatchTeamResult;
  away: MatchTeamResult;
}

export interface FormIndexResult {
  teamId: string;
  teamName: string;
  flag: string;
  crest?: string;
  overall: number; // 0-100
  breakdown: {
    points: number;
    goalDifference: number;
    xgPerformance: number;
    possession: number;
    shotsOnTarget: number;
    cleanSheets: number;
  };
  trend: number[]; // last N match ratings for sparkline
  played: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface TeamAverages {
  teamId: string;
  teamName: string;
  flag: string;
  crest?: string;
  played: number;
  avgGoalsScored: number;
  avgGoalsConceded: number;
  avgPossession: number;
  avgShotsOnTarget: number;
  avgPasses: number;
  avgPassAccuracy: number;
  avgXG: number;
  avgYellowCards: number;
  avgRedCards: number;
  avgCorners: number;
  totalGoals: number;
  totalYellowCards: number;
  totalRedCards: number;
}

export interface Scorer {
  player: string;
  teamId: string;
  goals: number;
  assists: number;
}

export interface UpcomingFixture {
  id: string;
  date: string; // YYYY-MM-DD
  kickoff: string; // full ISO datetime
  stage: Match["stage"];
  group: string;
  homeTeamId: string;
  awayTeamId: string;
}

export interface TournamentInsights {
  totalMatches: number;
  totalGoals: number;
  avgGoalsPerMatch: number;
  totalYellowCards: number;
  totalRedCards: number;
  mostCommonResults: { result: string; count: number }[];
  topScorers: { player: string; teamId: string; goals: number }[];
  topAssisters: { player: string; teamId: string; assists: number }[];
}
