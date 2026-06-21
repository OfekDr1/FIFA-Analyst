import { NextResponse } from "next/server";

// Server-side only — the API key never reaches the client.
const BASE_URL = "https://api.football-data.org/v4";
const COMPETITION = "WC";

export const dynamic = "force-dynamic"; // never statically cache live data

interface FdTeam {
  id: number;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
}

interface FdMatch {
  id: number;
  status: string;
  minute: number | string | null;
  stage: string;
  group: string | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score: { fullTime: { home: number | null; away: number | null } };
}

interface LiveTeam {
  id: string;
  name: string;
  tla?: string;
  crest?: string;
}

interface LiveMatch {
  id: string;
  status: string;
  minute: number | null;
  stage: string;
  group: string | null;
  home: LiveTeam;
  away: LiveTeam;
  score: { home: number; away: number };
}

function mapTeam(t: FdTeam): LiveTeam {
  return {
    id: String(t.id),
    name: t.shortName || t.name,
    tla: t.tla ?? undefined,
    crest: t.crest ?? undefined,
  };
}

function mapLive(m: FdMatch): LiveMatch {
  const minute =
    typeof m.minute === "string" ? parseInt(m.minute, 10) || null : m.minute ?? null;
  return {
    id: String(m.id),
    status: m.status,
    minute,
    stage: m.stage,
    group: m.group ?? null,
    home: mapTeam(m.homeTeam),
    away: mapTeam(m.awayTeam),
    score: {
      home: m.score?.fullTime?.home ?? 0,
      away: m.score?.fullTime?.away ?? 0,
    },
  };
}

// Demo fixture whose home score ticks up every 30s so the goal
// animation can be exercised without waiting for a real live match.
function demoMatch(): LiveMatch {
  const homeScore = Math.floor(Date.now() / 30000) % 5;
  const minute = (Math.floor(Date.now() / 60000) % 90) + 1;
  return {
    id: "demo-1",
    status: "IN_PLAY",
    minute,
    stage: "GROUP_STAGE",
    group: "GROUP_A",
    // 2-letter codes so flagcdn renders real flags in the demo
    home: { id: "demo-h", name: "Brazil", tla: "br" },
    away: { id: "demo-a", name: "Argentina", tla: "ar" },
    score: { home: homeScore, away: 1 },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("demo") === "1") {
    return NextResponse.json({ matches: [demoMatch()] });
  }

  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ matches: [], error: "missing-api-key" });
  }

  try {
    // Fetch all fixtures and filter live ones in code — robust regardless of
    // whether the API supports comma-separated status filters.
    const res = await fetch(`${BASE_URL}/competitions/${COMPETITION}/matches`, {
      headers: { "X-Auth-Token": apiKey },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ matches: [], error: `upstream-${res.status}` });
    }

    const json = await res.json();
    const live: LiveMatch[] = (json.matches ?? [])
      .filter(
        (m: FdMatch) => m.status === "IN_PLAY" || m.status === "PAUSED"
      )
      .map(mapLive);

    return NextResponse.json({ matches: live });
  } catch {
    // Degrade gracefully — the client just shows "No Active Transmissions".
    return NextResponse.json({ matches: [], error: "fetch-failed" });
  }
}
