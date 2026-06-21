"use client";

import { useState } from "react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  Legend,
} from "recharts";
import { ChevronDown, ChevronUp, Info, Flame } from "lucide-react";
import { FormIndexResult } from "@/types";
import { Crest } from "@/components/Crest";
import { Panel, EDGE_ACTIVE, PANEL_BG, glassTooltip } from "@/components/Hud";

interface Props {
  results: FormIndexResult[];
}

const METRIC_META: Record<string, { label: string; color: string }> = {
  points: { label: "Points", color: "#22d3ee" },
  goalDifference: { label: "Goal Diff", color: "#34d399" },
  xgPerformance: { label: "xG Perf", color: "#fbbf24" },
  possession: { label: "Possession", color: "#a78bfa" },
  shotsOnTarget: { label: "Shots OT", color: "#f472b6" },
  cleanSheets: { label: "Clean Sheets", color: "#60a5fa" },
};

function rankBadge(rank: number): string {
  if (rank === 1) return "bg-gradient-to-br from-amber-300 to-yellow-500 text-slate-900 shadow-[0_0_18px_-2px_rgba(251,191,36,0.8)]";
  if (rank === 2) return "bg-gradient-to-br from-slate-100 to-slate-400 text-slate-900 shadow-[0_0_16px_-3px_rgba(226,232,240,0.5)]";
  if (rank === 3) return "bg-gradient-to-br from-orange-400 to-amber-700 text-white shadow-[0_0_16px_-3px_rgba(234,88,12,0.5)]";
  return "bg-white/10 text-slate-300";
}

function scoreColor(score: number): string {
  if (score >= 75) return "#34d399";
  if (score >= 55) return "#22d3ee";
  if (score >= 40) return "#fbbf24";
  return "#fb7185";
}

function Sparkline({ data, id }: { data: number[]; id: string }) {
  const chartData = data.map((value, i) => ({ match: i + 1, value }));
  return (
    <div className="w-28 h-10">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, bottom: 2, left: 0, right: 0 }}>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke="#22d3ee"
            strokeWidth={2.5}
            fill={`url(#spark-${id})`}
            dot={false}
            isAnimationActive={false}
            style={{ filter: "drop-shadow(0 0 4px rgba(34,211,238,0.5))" }}
          />
          <Tooltip
            contentStyle={glassTooltip}
            labelFormatter={(l) => `Match ${l}`}
            formatter={(v: number) => [v, "Rating"]}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecordPills({ wins, draws, losses }: { wins: number; draws: number; losses: number }) {
  return (
    <div className="flex items-center gap-1 font-mono text-xs font-bold">
      <span className="px-1.5 py-0.5 rounded-md bg-emerald-400/15 text-emerald-300">{wins}</span>
      <span className="px-1.5 py-0.5 rounded-md bg-slate-400/15 text-slate-300">{draws}</span>
      <span className="px-1.5 py-0.5 rounded-md bg-rose-400/15 text-rose-300">{losses}</span>
    </div>
  );
}

function BreakdownRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-400 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${value}%`,
            backgroundImage: `linear-gradient(90deg, ${color}99, ${color})`,
            boxShadow: `0 0 12px -1px ${color}aa`,
          }}
        />
      </div>
      <span className="text-xs font-mono font-semibold text-slate-200 w-10 text-right">
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function ExpandedDetails({ result }: { result: FormIndexResult }) {
  const breakdownData = Object.entries(result.breakdown).map(([key, value]) => ({
    name: METRIC_META[key].label,
    value,
    fill: METRIC_META[key].color,
  }));

  return (
    <div className="px-5 pb-5 pt-1">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/10">
        <div className="space-y-3">
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-[0.15em]">
            Score Breakdown
          </h4>
          <div className="space-y-2.5">
            {Object.entries(result.breakdown).map(([key, value]) => (
              <BreakdownRow key={key} label={METRIC_META[key].label} value={value} color={METRIC_META[key].color} />
            ))}
          </div>
        </div>
        <div>
          <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-[0.15em] mb-3">
            Component Scores
          </h4>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={breakdownData} layout="vertical">
                <XAxis type="number" domain={[0, 100]} hide />
                <YAxis type="category" dataKey="name" width={72} tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={glassTooltip} formatter={(v: number) => [v.toFixed(1), "Score"]} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={14}>
                  {breakdownData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

function RankRow({
  result,
  rank,
  isExpanded,
  onToggle,
  delay,
}: {
  result: FormIndexResult;
  rank: number;
  isExpanded: boolean;
  onToggle: () => void;
  delay: number;
}) {
  const top3 = rank <= 3;
  const clip = rank % 2 === 1 ? "clip-tile" : "clip-tile-alt";
  const sc = scoreColor(result.overall);

  return (
    <div className="relative animate-unfold" style={{ animationDelay: `${delay}ms` }}>
      {/* matrix node on the rail */}
      <span
        className={`absolute -left-[20px] top-7 w-2.5 h-2.5 rotate-45 transition-all duration-300 ${
          top3
            ? "bg-lime-300 shadow-[0_0_14px_2px_rgba(163,230,53,0.8)]"
            : "bg-[#0b0713] border border-cyan-400/80 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
        }`}
      />
      <div
        className={`relative ${clip} p-px bg-gradient-to-r transition-[transform,filter] duration-300 ${
          isExpanded ? "-translate-y-0.5" : "hover:-translate-y-0.5"
        } ${top3 ? `${EDGE_ACTIVE} hud-glow` : "from-white/12 to-white/5"}`}
      >
        <div className={`relative ${clip} ${PANEL_BG} hud-scanlines`}>
          <div
            onClick={onToggle}
            className="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_1fr_7rem_auto_auto] gap-3 sm:gap-4 px-3 sm:px-5 py-3.5 sm:py-4 items-center cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <span className={`grid place-items-center w-8 h-8 clip-cell text-sm font-extrabold ${rankBadge(rank)}`}>
                {rank}
              </span>
              <Crest crest={result.crest} flag={result.flag} name={result.teamName} size={44} glow={top3} />
            </div>

            <div className="min-w-0">
              <p className="font-bold text-slate-50 truncate text-[15px]">{result.teamName}</p>
              <div className="mt-1">
                <RecordPills wins={result.wins} draws={result.draws} losses={result.losses} />
              </div>
            </div>

            <div className="hidden sm:flex justify-center">
              <Sparkline data={result.trend} id={result.teamId} />
            </div>

            <div className="text-right">
              <span
                className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums"
                style={{ color: sc, textShadow: `0 0 22px ${sc}66` }}
              >
                {result.overall.toFixed(1)}
              </span>
              <p className="text-[10px] uppercase tracking-widest text-slate-500 -mt-0.5">Form</p>
            </div>

            <div className="flex justify-end text-slate-500">
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </div>

          {isExpanded && <ExpandedDetails result={result} />}
        </div>
      </div>
    </div>
  );
}

function CompareRadar({ results, selected }: { results: FormIndexResult[]; selected: [string, string] }) {
  const team1 = results.find((r) => r.teamId === selected[0]);
  const team2 = results.find((r) => r.teamId === selected[1]);
  if (!team1 || !team2) return null;

  const radarData = Object.keys(METRIC_META).map((key) => ({
    stat: METRIC_META[key].label,
    [team1.teamName]: team1.breakdown[key as keyof typeof team1.breakdown],
    [team2.teamName]: team2.breakdown[key as keyof typeof team2.breakdown],
  }));

  return (
    <div className="mt-6">
      <div className="flex items-center justify-center gap-4 mb-2">
        <div className="flex items-center gap-2">
          <Crest crest={team1.crest} flag={team1.flag} name={team1.teamName} size={28} />
          <span className="text-sm font-semibold text-cyan-300">{team1.teamName}</span>
        </div>
        <span className="text-xs text-slate-500 font-bold">VS</span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-amber-300">{team2.teamName}</span>
          <Crest crest={team2.crest} flag={team2.flag} name={team2.teamName} size={28} />
        </div>
      </div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="72%">
            <PolarGrid stroke="rgba(255,255,255,0.1)" />
            <PolarAngleAxis dataKey="stat" tick={{ fontSize: 11, fill: "#94a3b8" }} />
            <Radar name={team1.teamName} dataKey={team1.teamName} stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.25} strokeWidth={2} style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.5))" }} />
            <Radar name={team2.teamName} dataKey={team2.teamName} stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.2} strokeWidth={2} style={{ filter: "drop-shadow(0 0 6px rgba(251,191,36,0.45))" }} />
            <Legend wrapperStyle={{ fontSize: "12px", color: "#94a3b8" }} />
            <Tooltip contentStyle={glassTooltip} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function FormIndex({ results }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [compareTeams, setCompareTeams] = useState<[string, string]>([
    results[0]?.teamId ?? "",
    results[1]?.teamId ?? "",
  ]);

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between animate-unfold">
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight flex items-center gap-2.5">
            <Flame className="w-6 h-6 text-cyan-400" />
            <span className="bg-gradient-to-r from-white to-cyan-200 bg-clip-text text-transparent">
              Power Rankings
            </span>
          </h2>
          <p className="text-sm text-slate-400 mt-1.5">
            Form Index weighting results, xG, possession, shots &amp; defensive
            record — adjusted for opponent strength.
          </p>
        </div>
        <div className="group relative">
          <Info className="w-4 h-4 text-slate-500 cursor-help" />
          <div className="absolute right-0 top-6 w-72 clip-tile border border-white/10 bg-[#0b0713]/95 backdrop-blur-xl p-3.5 text-xs text-slate-300 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-20">
            <p className="font-semibold text-white mb-1">How it works</p>
            <p className="leading-relaxed">
              Points (35%) · Goal Diff (20%) · xG (20%) · Possession (10%) ·
              Shots on Target (10%) · Clean Sheets (5%). Recent matches and
              tougher opponents are weighted higher.
            </p>
          </div>
        </div>
      </div>

      {/* Rankings matrix */}
      <div className="relative pl-6">
        <div className="absolute left-[8px] top-4 bottom-4 w-px bg-gradient-to-b from-cyan-400/50 via-fuchsia-500/30 to-transparent" />
        <div className="flex flex-col gap-2.5">
          {results.map((result, index) => (
            <RankRow
              key={result.teamId}
              result={result}
              rank={index + 1}
              isExpanded={expandedId === result.teamId}
              onToggle={() =>
                setExpandedId(expandedId === result.teamId ? null : result.teamId)
              }
              delay={index * 70}
            />
          ))}
        </div>
      </div>

      {/* Overview bar chart */}
      <Panel clip="clip-panel" delay={200} className="p-4 sm:p-6">
        <h3 className="text-sm font-bold text-slate-100 mb-5 uppercase tracking-wider">
          Form Index Overview
        </h3>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={results.map((r) => ({ name: r.teamName, score: r.overall }))} margin={{ top: 10, right: 0, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="formBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" />
                  <stop offset="100%" stopColor="#22d3ee" />
                </linearGradient>
              </defs>
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} interval={0} angle={-20} textAnchor="end" height={50} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={glassTooltip} formatter={(v: number) => [v.toFixed(1), "Form Index"]} />
              <Bar dataKey="score" radius={[8, 8, 0, 0]} barSize={38} fill="url(#formBar)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {/* Radar comparison */}
      <Panel clip="clip-panel-alt" delay={320} className="p-4 sm:p-6">
        <h3 className="text-sm font-bold text-slate-100 mb-5 uppercase tracking-wider">
          Head-to-Head Comparison
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          {[0, 1].map((idx) => (
            <select
              key={idx}
              value={compareTeams[idx]}
              onChange={(e) => {
                const next = [...compareTeams] as [string, string];
                next[idx] = e.target.value;
                setCompareTeams(next);
              }}
              className="flex-1 clip-tile bg-white/5 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/40 transition-all"
            >
              {results.map((r) => (
                <option key={r.teamId} value={r.teamId} className="bg-slate-900">
                  {r.teamName}
                </option>
              ))}
            </select>
          ))}
        </div>
        <CompareRadar results={results} selected={compareTeams} />
      </Panel>
    </div>
  );
}
