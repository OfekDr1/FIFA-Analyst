"use client";

import { type ElementType } from "react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
} from "recharts";
import {
  Goal,
  TrendingUp,
  Hash,
  AlertTriangle,
  Award,
  HandHelping,
  Calendar,
} from "lucide-react";
import {
  Match,
  Team,
  TournamentInsights as TournamentInsightsType,
} from "@/types";
import { Crest } from "@/components/Crest";
import { Panel, PolyTile, AccentRail, glassTooltip } from "@/components/Hud";

interface Props {
  insights: TournamentInsightsType;
  matches: Match[];
  teams: Team[];
}

const PIE_COLORS = ["#22d3ee", "#fbbf24"];

function StatBadge({
  icon: Icon,
  label,
  value,
  color,
  delay,
  clip,
}: {
  icon: ElementType;
  label: string;
  value: string;
  color: string;
  delay: number;
  clip: string;
}) {
  return (
    <PolyTile clip={clip} delay={delay} className="p-4 sm:p-5 flex items-center gap-3 sm:gap-4">
      <div
        className="grid place-items-center w-12 h-12 clip-cell shrink-0"
        style={{ backgroundColor: `${color}1f`, boxShadow: `0 0 22px -6px ${color}` }}
      >
        <Icon className="w-6 h-6" style={{ color }} />
      </div>
      <div>
        <p className="text-[11px] text-slate-500 uppercase tracking-wider">{label}</p>
        <p className="text-3xl font-extrabold font-mono tabular-nums" style={{ color, textShadow: `0 0 22px ${color}55` }}>
          {value}
        </p>
      </div>
    </PolyTile>
  );
}

function OutcomesPieChart({ matches }: { matches: Match[] }) {
  const draws = matches.filter((m) => m.home.goals === m.away.goals).length;
  const decisive = matches.length - draws;
  const data = [
    { name: "Decisive", value: decisive },
    { name: "Draws", value: draws },
  ];

  return (
    <Panel clip="clip-panel-alt" delay={360} className="p-4 sm:p-6">
      <h3 className="text-sm font-bold text-slate-100 mb-4 uppercase tracking-wider">Match Outcomes</h3>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={56} outerRadius={82} paddingAngle={4} dataKey="value" stroke="none">
              {data.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i]} style={{ filter: `drop-shadow(0 0 8px ${PIE_COLORS[i]}88)` }} />
              ))}
            </Pie>
            <Tooltip contentStyle={glassTooltip} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-center gap-6 mt-2">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rotate-45" style={{ backgroundColor: PIE_COLORS[i], boxShadow: `0 0 8px ${PIE_COLORS[i]}` }} />
            <span className="text-slate-400">
              {d.name}: <span className="font-bold text-slate-100">{d.value}</span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CommonResults({ results }: { results: { result: string; count: number }[] }) {
  return (
    <Panel clip="clip-panel" delay={300} className="p-4 sm:p-6">
      <h3 className="text-sm font-bold text-slate-100 mb-4 uppercase tracking-wider">Most Common Results</h3>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={results.slice(0, 6)}>
            <defs>
              <linearGradient id="resultBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" />
                <stop offset="100%" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
            <XAxis dataKey="result" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={glassTooltip} formatter={(v: number) => [v, "Matches"]} />
            <Bar dataKey="count" fill="url(#resultBar)" radius={[8, 8, 0, 0]} barSize={34} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function LeaderboardTable({
  title,
  icon: Icon,
  color,
  data,
  valueLabel,
  teams,
  delay,
  clip,
  rail,
}: {
  title: string;
  icon: ElementType;
  color: string;
  data: { player: string; teamId: string; [k: string]: unknown }[];
  valueLabel: string;
  teams: Team[];
  delay: number;
  clip: string;
  rail: string;
}) {
  const getTeam = (id: string) => teams.find((t) => t.id === id);
  const getValue = (d: (typeof data)[0]) =>
    (d.goals as number | undefined) ?? (d.assists as number | undefined) ?? 0;

  return (
    <Panel clip={clip} delay={delay} className="p-4 sm:p-6 pl-6 sm:pl-8">
      <AccentRail gradient={rail} />
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4" style={{ color }} />
        <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">{title}</h3>
      </div>

      {data.length === 0 ? (
        <p className="text-xs text-slate-500 py-6 text-center">No scorer data available on this API tier.</p>
      ) : (
        <div className="space-y-1.5">
          {data.slice(0, 5).map((d, i) => {
            const team = getTeam(d.teamId);
            return (
              <div
                key={`${d.player}-${d.teamId}`}
                className={`flex items-center justify-between py-2.5 px-3 clip-tile transition-all duration-300 hover:bg-white/5 ${
                  i === 0 ? "bg-white/5" : ""
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`grid place-items-center w-6 h-6 clip-cell text-[11px] font-extrabold shrink-0 ${
                      i === 0 ? "bg-gradient-to-br from-amber-300 to-yellow-500 text-slate-900 shadow-[0_0_14px_-3px_rgba(251,191,36,0.8)]" : "bg-white/10 text-slate-400"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <Crest crest={team?.crest} flag={team?.flag} name={team?.name ?? ""} size={26} />
                  <span className="text-sm text-slate-100 font-semibold truncate">{d.player}</span>
                </div>
                <span className="text-sm font-extrabold font-mono shrink-0" style={{ color, textShadow: `0 0 14px ${color}55` }}>
                  {getValue(d)}
                  <span className="text-[10px] text-slate-500 ml-1 font-normal">{valueLabel}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function MatchFeed({ matches, teams }: { matches: Match[]; teams: Team[] }) {
  const getTeam = (id: string) => teams.find((t) => t.id === id);
  const sorted = [...matches].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)
  );

  return (
    <Panel clip="clip-panel" delay={620} className="p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-4">
        <Calendar className="w-4 h-4 text-cyan-400" />
        <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">Recent Matches</h3>
      </div>
      <div className="space-y-2 max-h-[440px] overflow-y-auto pr-1">
        {sorted.map((match, idx) => {
          const home = getTeam(match.home.teamId);
          const away = getTeam(match.away.teamId);
          const homeWin = match.home.goals > match.away.goals;
          const awayWin = match.away.goals > match.home.goals;
          const clip = idx % 2 === 0 ? "clip-tile" : "clip-tile-alt";

          return (
            <div
              key={match.id}
              className={`flex items-center gap-2 sm:gap-3 py-3 px-3 sm:px-4 ${clip} bg-white/[0.03] border border-white/5 hover:bg-white/[0.07] transition-all duration-300`}
            >
              <div className="w-16 shrink-0">
                <p className="text-xs font-semibold text-slate-300">
                  {new Date(match.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </p>
                <p className="text-[10px] text-slate-600 capitalize">{match.stage.replace("-", " ")}</p>
              </div>

              <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
                <span className={`text-sm font-semibold truncate ${homeWin ? "text-slate-50" : "text-slate-400"}`}>{home?.name}</span>
                <Crest crest={home?.crest} flag={home?.flag} name={home?.name ?? ""} size={26} />
              </div>

              <div className="grid place-items-center min-w-[3.5rem] px-2.5 py-1 clip-cell bg-black/50 border border-white/10">
                <span className="text-base font-extrabold font-mono text-slate-50">
                  {match.home.goals}
                  <span className="text-slate-600 mx-1">-</span>
                  {match.away.goals}
                </span>
              </div>

              <div className="flex-1 flex items-center gap-2 min-w-0">
                <Crest crest={away?.crest} flag={away?.flag} name={away?.name ?? ""} size={26} />
                <span className={`text-sm font-semibold truncate ${awayWin ? "text-slate-50" : "text-slate-400"}`}>{away?.name}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function TournamentInsights({ insights, matches, teams }: Props) {
  return (
    <div className="space-y-8">
      <div className="animate-unfold">
        <h2 className="text-2xl font-extrabold tracking-tight flex items-center gap-2.5">
          <TrendingUp className="w-6 h-6 text-violet-400" />
          <span className="bg-gradient-to-r from-white to-violet-200 bg-clip-text text-transparent">
            Tournament Insights
          </span>
        </h2>
        <p className="text-sm text-slate-400 mt-1.5">Global statistics and trends across all matches.</p>
      </div>

      {/* Summary badges */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatBadge icon={Goal} label="Total Goals" value={String(insights.totalGoals)} color="#34d399" delay={0} clip="clip-tile" />
        <StatBadge icon={TrendingUp} label="Avg Goals / Match" value={insights.avgGoalsPerMatch.toFixed(2)} color="#22d3ee" delay={80} clip="clip-tile-alt" />
        <StatBadge icon={AlertTriangle} label="Yellow Cards" value={String(insights.totalYellowCards)} color="#facc15" delay={160} clip="clip-tile" />
        <StatBadge icon={Hash} label="Matches Played" value={String(insights.totalMatches)} color="#a78bfa" delay={240} clip="clip-tile-alt" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CommonResults results={insights.mostCommonResults} />
        <OutcomesPieChart matches={matches} />
      </div>

      {/* Databank leaderboards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LeaderboardTable title="Top Scorers" icon={Award} color="#fbbf24" data={insights.topScorers} valueLabel="goals" teams={teams} delay={440} clip="clip-panel" rail="from-amber-300 via-amber-400 to-fuchsia-500" />
        <LeaderboardTable title="Top Assisters" icon={HandHelping} color="#22d3ee" data={insights.topAssisters} valueLabel="assists" teams={teams} delay={520} clip="clip-panel-alt" rail="from-cyan-400 via-cyan-300 to-fuchsia-500" />
      </div>

      {/* Match feed */}
      <MatchFeed matches={matches} teams={teams} />
    </div>
  );
}
