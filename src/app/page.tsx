import { fetchDashboardData } from "@/lib/api";
import { DashboardShell } from "@/components/DashboardShell";
import { Team, Match, Scorer, UpcomingFixture } from "@/types";

import { teams as mockTeams } from "@/data/teams";
import { matches as mockMatches } from "@/data/matches";

export const revalidate = 300; // ISR: regenerate every 5 minutes

// Synthesize a few upcoming fixtures so the timeline is demonstrable when the
// live API is unavailable and we fall back to bundled mock data.
function buildMockUpcoming(teams: Team[]): UpcomingFixture[] {
  const pairs: [number, number][] = [
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
  ];
  const base = Date.parse("2026-06-24T18:00:00Z");
  return pairs
    .filter(([a, b]) => teams[a] && teams[b])
    .map(([a, b], i) => {
      const kickoff = new Date(base + i * 86_400_000).toISOString();
      return {
        id: `mock-up-${i}`,
        date: kickoff.split("T")[0],
        kickoff,
        stage: "round-of-16" as const,
        group: "",
        homeTeamId: teams[a].id,
        awayTeamId: teams[b].id,
      };
    });
}

export default async function Page() {
  let teams: Team[];
  let matches: Match[];
  let scorers: Scorer[] = [];
  let upcoming: UpcomingFixture[] = [];
  let usingMockData = false;

  try {
    const data = await fetchDashboardData();
    teams = data.teams;
    matches = data.matches;
    scorers = data.scorers;
    upcoming = data.upcoming;
  } catch (error) {
    console.error("[page] API fetch failed, falling back to mock data:", error);
    teams = mockTeams;
    matches = mockMatches;
    upcoming = buildMockUpcoming(mockTeams);
    usingMockData = true;
  }

  return (
    <DashboardShell
      teams={teams}
      matches={matches}
      scorers={scorers}
      upcoming={upcoming}
      usingMockData={usingMockData}
    />
  );
}
