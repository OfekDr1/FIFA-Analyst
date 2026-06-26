"use client";

import { useState } from "react";
import {
  Trophy,
  BarChart3,
  TrendingUp,
  Swords,
  Target,
  Route,
  Activity,
  Info,
} from "lucide-react";
import { Team, Match, Scorer, UpcomingFixture } from "@/types";
import { calculateFormIndex } from "@/lib/formIndex";
import {
  calculateAllTeamAverages,
  calculateTournamentInsights,
} from "@/lib/stats";
import { FormIndex } from "@/components/FormIndex";
import { TeamStats } from "@/components/TeamStats";
import { TournamentInsights } from "@/components/TournamentInsights";
import { Predictions } from "@/components/Predictions";
import RoadToTheFinal from "@/components/RoadToTheFinal";
import { PredictionAccuracy } from "@/components/PredictionAccuracy";
import { CalibrationWidget } from "@/components/CalibrationWidget";
import { LiveMatchTracker } from "@/components/LiveMatchTracker";
import { GoalCelebrationOverlay } from "@/components/GoalCelebrationOverlay";
import { useLiveMatches } from "@/hooks/useLiveMatches";

const tabs = [
  { id: "form", label: "Power Rankings", icon: Trophy },
  { id: "stats", label: "Team Stats", icon: BarChart3 },
  { id: "insights", label: "Tournament Insights", icon: TrendingUp },
  { id: "predictions", label: "Predictions", icon: Swords },
  { id: "road", label: "Road to Final", icon: Route },
  { id: "accuracy", label: "Accuracy", icon: Target },
] as const;

type TabId = (typeof tabs)[number]["id"];

interface Props {
  teams: Team[];
  matches: Match[];
  scorers?: Scorer[];
  upcoming?: UpcomingFixture[];
  usingMockData?: boolean;
}

export function DashboardShell({
  teams,
  matches,
  scorers = [],
  upcoming = [],
  usingMockData = false,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("form");

  // Live-match polling + goal detection. The goal drives a portal overlay;
  // the matches feed the in-page tracker. (Pass `true` here to demo goals.)
  const live = useLiveMatches();

  const formIndexResults = calculateFormIndex(teams, matches);
  const teamAverages = calculateAllTeamAverages(teams, matches);
  const tournamentInsights = calculateTournamentInsights(teams, matches, scorers);

  return (
    <div className="relative min-h-screen text-slate-100 overflow-x-clip">
      {/* Global goal takeover — portals to <body>, above everything */}
      <GoalCelebrationOverlay goal={live.goal} />

      {/* ── Cinematic animated background ── */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-32 h-[36rem] w-[36rem] rounded-full bg-fuchsia-600/20 blur-[150px] animate-glow-1" />
        <div className="absolute top-1/3 -right-40 h-[34rem] w-[34rem] rounded-full bg-cyan-500/16 blur-[150px] animate-glow-2" />
        <div className="absolute -bottom-40 left-1/4 h-[34rem] w-[34rem] rounded-full bg-violet-700/22 blur-[160px] animate-glow-3" />
        <div className="absolute top-10 left-1/2 h-[24rem] w-[24rem] rounded-full bg-pink-500/12 blur-[140px] animate-glow-2" />
        <div
          className="absolute inset-0 opacity-[0.02]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <div className="relative z-10">
        {/* ── Header ── */}
        <header className="sticky top-0 z-50 border-b border-white/10 bg-[#07040f]/60 backdrop-blur-xl">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16 sm:h-20 gap-2">
              <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
                <div className="relative grid place-items-center w-9 h-9 sm:w-11 sm:h-11 rounded-2xl bg-gradient-to-br from-fuchsia-500/25 to-cyan-400/25 ring-1 ring-white/15 shadow-[0_0_30px_-6px_rgba(217,70,239,0.7)] shrink-0">
                  <Activity className="w-4 h-4 sm:w-5 sm:h-5 text-fuchsia-200" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm sm:text-xl font-extrabold tracking-tight bg-gradient-to-r from-fuchsia-200 via-white to-cyan-200 bg-clip-text text-transparent truncate">
                    FIFA World Cup 2026
                  </h1>
                  <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-fuchsia-300/70 font-semibold">
                    Broadcast Analytics
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                {/* Estimated-stats honesty badge */}
                <div className="group relative">
                  <div className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full bg-amber-400/10 border border-amber-400/30 text-amber-300 text-xs font-semibold cursor-help transition-all duration-300 hover:bg-amber-400/15">
                    <Info className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Estimated stats</span>
                  </div>
                  <div className="absolute right-0 top-10 w-72 rounded-xl border border-white/10 bg-[#0c0717]/95 backdrop-blur-xl p-3.5 text-xs text-slate-300 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-300 z-50 shadow-2xl">
                    <p className="font-semibold text-white mb-1">
                      Data transparency
                    </p>
                    <p className="leading-relaxed">
                      {usingMockData
                        ? "Live API unavailable — showing bundled mock data. "
                        : "Results, scores & top scorers are live from football-data.org. "}
                      Possession, xG, shots &amp; cards aren&apos;t on the free
                      tier, so they&apos;re deterministically estimated from
                      scorelines.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 px-2.5 sm:px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs text-slate-400">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
                  </span>
                  <span className="font-semibold text-slate-200">
                    {matches.length}
                  </span>
                  <span className="hidden sm:inline">matches tracked</span>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* ── Floating glass HUD ── */}
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-8">
          {/* Live match strip (presentational); goal celebration is the global overlay */}
          <LiveMatchTracker
            matches={live.matches}
            ready={live.ready}
            muted={live.muted}
            toggleMute={live.toggleMute}
          />

          <div className="rounded-[1.75rem] sm:rounded-[2rem] bg-white/[0.045] backdrop-blur-2xl border border-white/10 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.85)] ring-1 ring-white/5">
            {/* Tab Navigation */}
            <nav className="px-3 sm:px-6 pt-4 sm:pt-5">
              <div className="flex w-full sm:inline-flex sm:w-auto flex-wrap gap-1 p-1.5 rounded-2xl bg-black/20 border border-white/10">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center justify-center gap-2 flex-1 sm:flex-none px-3 sm:px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 ${
                        isActive
                          ? "bg-gradient-to-r from-fuchsia-500/30 to-cyan-500/25 text-white shadow-[0_0_26px_-6px_rgba(217,70,239,0.8)] ring-1 ring-fuchsia-400/30"
                          : "text-slate-400 hover:text-slate-100 hover:bg-white/5"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span className="hidden sm:inline">{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </nav>

            {/* Content */}
            <main className="px-3 sm:px-6 lg:px-8 py-6 sm:py-8">
              {activeTab === "form" && <FormIndex results={formIndexResults} />}
              {activeTab === "stats" && <TeamStats averages={teamAverages} />}
              {activeTab === "insights" && (
                <TournamentInsights
                  insights={tournamentInsights}
                  matches={matches}
                  teams={teams}
                />
              )}
              {activeTab === "predictions" && (
                <Predictions teams={teams} matches={matches} upcoming={upcoming} />
              )}
              {activeTab === "road" && <RoadToTheFinal />}
              {activeTab === "accuracy" && (
                <div className="space-y-10">
                  <PredictionAccuracy teams={teams} matches={matches} />
                  <CalibrationWidget teams={teams} matches={matches} />
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
