"use client";

import { useState, type ElementType } from "react";
import {
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  Tooltip,
} from "recharts";
import {
  Target,
  ShieldAlert,
  Percent,
  Crosshair,
  ArrowUpDown,
  SquareSlash,
  TriangleAlert,
  CircleDot,
  BarChart3,
} from "lucide-react";
import { TeamAverages } from "@/types";
import { Crest } from "@/components/Crest";
import { glassTooltip } from "@/components/Hud";

interface Props {
  averages: TeamAverages[];
}

interface StatConfig {
  key: keyof TeamAverages;
  label: string;
  icon: ElementType;
  color: string;
  format: (v: number) => string;
  higherIsBetter: boolean;
}

const STATS: StatConfig[] = [
  { key: "avgGoalsScored", label: "Goals Scored", icon: Target, color: "#34d399", format: (v) => v.toFixed(2), higherIsBetter: true },
  { key: "avgGoalsConceded", label: "Goals Conceded", icon: ShieldAlert, color: "#fb7185", format: (v) => v.toFixed(2), higherIsBetter: false },
  { key: "avgPossession", label: "Possession %", icon: Percent, color: "#a78bfa", format: (v) => `${v.toFixed(1)}%`, higherIsBetter: true },
  { key: "avgShotsOnTarget", label: "Shots on Target", icon: Crosshair, color: "#22d3ee", format: (v) => v.toFixed(2), higherIsBetter: true },
  { key: "avgXG", label: "Expected Goals", icon: CircleDot, color: "#fbbf24", format: (v) => v.toFixed(2), higherIsBetter: true },
  { key: "avgPassAccuracy", label: "Pass Accuracy", icon: ArrowUpDown, color: "#60a5fa", format: (v) => `${v.toFixed(1)}%`, higherIsBetter: true },
  { key: "avgCorners", label: "Corners", icon: SquareSlash, color: "#f472b6", format: (v) => v.toFixed(2), higherIsBetter: true },
  { key: "avgYellowCards", label: "Yellow Cards", icon: TriangleAlert, color: "#facc15", format: (v) => v.toFixed(2), higherIsBetter: false },
];

// Stats used for the radar profile (label + whether higher is better)
const RADAR_STATS: { key: keyof TeamAverages; label: string; higher: boolean }[] = [
  { key: "avgGoalsScored", label: "Attack", higher: true },
  { key: "avgGoalsConceded", label: "Defense", higher: false },
  { key: "avgPossession", label: "Possession", higher: true },
  { key: "avgShotsOnTarget", label: "Shots", higher: true },
  { key: "avgXG", label: "xG", higher: true },
  { key: "avgPassAccuracy", label: "Passing", higher: true },
];

type SortKey = "name" | keyof TeamAverages;

function tournamentAvg(averages: TeamAverages[], key: keyof TeamAverages): number {
  const vals = averages.map((a) => a[key] as number);
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function statRange(averages: TeamAverages[], key: keyof TeamAverages) {
  const vals = averages.map((a) => a[key] as number);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

// Normalize a value to 0–100 relative to the field; invert when lower is better.
function normalize(value: number, min: number, max: number, higher: boolean): number {
  const range = max - min || 1;
  const pct = ((value - min) / range) * 100;
  return Math.round(higher ? pct : 100 - pct);
}

function ComparisonBar({
  value,
  avg,
  min,
  max,
  color,
  higherIsBetter,
}: {
  value: number;
  avg: number;
  min: number;
  max: number;
  color: string;
  higherIsBetter: boolean;
}) {
  const range = max - min || 1;
  const pct = ((value - min) / range) * 100;
  const avgPct = ((avg - min) / range) * 100;
  const isAboveAvg = higherIsBetter ? value >= avg : value <= avg;

  return (
    <div className="mt-2 space-y-1">
      <div className="relative h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className="absolute h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundImage: `linear-gradient(90deg, ${color}80, ${color})`, boxShadow: `0 0 12px -1px ${color}cc` }}
        />
        <div className="absolute top-1/2 -translate-y-1/2 w-px h-3.5 bg-white/40" style={{ left: `${avgPct}%` }} />
      </div>
      <div className="flex justify-between items-center">
        <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: isAboveAvg ? "#34d399" : "#fb7185" }}>
          {isAboveAvg ? "▲ Above avg" : "▼ Below avg"}
        </span>
        <span className="text-[10px] text-slate-500">Avg {avg.toFixed(2)}</span>
      </div>
    </div>
  );
}

function TeamRadar({ team, averages }: { team: TeamAverages; averages: TeamAverages[] }) {
  const radarData = RADAR_STATS.map((s) => {
    const { min, max } = statRange(averages, s.key);
    const tAvg = tournamentAvg(averages, s.key);
    return {
      stat: s.label,
      Team: normalize(team[s.key] as number, min, max, s.higher),
      "Field Avg": normalize(tAvg, min, max, s.higher),
    };
  });

  return (
    <div className="h-56 mt-4">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid stroke="rgba(255,255,255,0.1)" />
          <PolarAngleAxis dataKey="stat" tick={{ fontSize: 10, fill: "#94a3b8" }} />
          <Radar name="Field Avg" dataKey="Field Avg" stroke="#64748b" fill="#64748b" fillOpacity={0.15} strokeWidth={1.5} />
          <Radar
            name="Team"
            dataKey="Team"
            stroke="#22d3ee"
            fill="#22d3ee"
            fillOpacity={0.3}
            strokeWidth={2}
            style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.55))" }}
          />
          <Tooltip contentStyle={glassTooltip} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TeamStats({ averages }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("avgGoalsScored");
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);

  const sorted = [...averages].sort((a, b) => {
    if (sortKey === "name") {
      return sortAsc ? a.teamName.localeCompare(b.teamName) : b.teamName.localeCompare(a.teamName);
    }
    const va = a[sortKey] as number;
    const vb = b[sortKey] as number;
    return sortAsc ? va - vb : vb - va;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="animate-unfold">
        <h2 className="text-2xl font-extrabold tracking-tight flex items-center gap-2.5">
          <BarChart3 className="w-6 h-6 text-emerald-400" />
          <span className="bg-gradient-to-r from-white to-emerald-200 bg-clip-text text-transparent">
            Team Statistics
          </span>
        </h2>
        <p className="text-sm text-slate-400 mt-1.5">
          Per-match averages benchmarked against the tournament average.
        </p>
      </div>

      {/* Sort controls */}
      <div className="flex flex-wrap gap-2 animate-unfold" style={{ animationDelay: "80ms" }}>
        <span className="text-xs text-slate-500 self-center mr-1 uppercase tracking-wider">Sort</span>
        {[{ key: "name" as SortKey, label: "Name" }, ...STATS.map((s) => ({ key: s.key as SortKey, label: s.label }))].map((opt) => {
          const active = sortKey === opt.key;
          return (
            <button
              key={opt.key}
              onClick={() => handleSort(opt.key)}
              className={`clip-tile px-3 py-1.5 text-xs font-semibold transition-all duration-300 ${
                active
                  ? "bg-gradient-to-r from-cyan-500/30 to-fuchsia-500/20 text-cyan-100 shadow-[0_0_18px_-6px_rgba(34,211,238,0.8)]"
                  : "bg-white/5 text-slate-400 hover:text-slate-100"
              }`}
            >
              {opt.label}
              {active && <span className="ml-1">{sortAsc ? "↑" : "↓"}</span>}
            </button>
          );
        })}
      </div>

      {/* Team poly-panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {sorted.map((team, idx) => {
          const isSelected = selectedTeam === team.teamId;
          const clip = idx % 2 === 0 ? "clip-panel" : "clip-panel-alt";
          return (
            <div
              key={team.teamId}
              className="animate-unfold"
              style={{ animationDelay: `${idx * 70}ms` }}
              onClick={() => setSelectedTeam(isSelected ? null : team.teamId)}
            >
              <div
                className={`relative ${clip} p-px bg-gradient-to-br transition-[transform,filter] duration-300 hover:-translate-y-1 cursor-pointer ${
                  isSelected ? "from-cyan-300/90 via-fuchsia-400/60 to-lime-300/50 hud-glow" : "from-white/15 to-white/5"
                }`}
              >
                <div className={`relative ${clip} bg-[#0b0713]/85 backdrop-blur-md hud-scanlines p-4 sm:p-5`}>
                  <div className="flex items-center gap-3 mb-4 pb-3 border-b border-white/10">
                    <Crest crest={team.crest} flag={team.flag} name={team.teamName} size={42} />
                    <div className="min-w-0">
                      <h3 className="font-bold text-slate-50 truncate">{team.teamName}</h3>
                      <span className="text-[11px] text-slate-500 uppercase tracking-wider">
                        {team.played} matches
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3.5">
                    {STATS.slice(0, isSelected ? STATS.length : 4).map((stat) => {
                      const value = team[stat.key] as number;
                      const avg = tournamentAvg(averages, stat.key);
                      const { min, max } = statRange(averages, stat.key);
                      const Icon = stat.icon;
                      return (
                        <div key={stat.key}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div
                                className="grid place-items-center w-7 h-7 clip-cell"
                                style={{ backgroundColor: `${stat.color}1f`, boxShadow: `0 0 14px -5px ${stat.color}` }}
                              >
                                <Icon className="w-3.5 h-3.5" style={{ color: stat.color }} />
                              </div>
                              <span className="text-xs text-slate-300">{stat.label}</span>
                            </div>
                            <span className="text-base font-extrabold font-mono tabular-nums" style={{ color: stat.color, textShadow: `0 0 16px ${stat.color}55` }}>
                              {stat.format(value)}
                            </span>
                          </div>
                          <ComparisonBar value={value} avg={avg} min={min} max={max} color={stat.color} higherIsBetter={stat.higherIsBetter} />
                        </div>
                      );
                    })}
                  </div>

                  {isSelected ? (
                    <div className="mt-4 pt-4 border-t border-white/10">
                      <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-[0.15em]">
                        Performance Profile
                      </h4>
                      <TeamRadar team={team} averages={averages} />
                    </div>
                  ) : (
                    <p className="text-[10px] text-slate-500 text-center mt-4 uppercase tracking-wider">
                      Click to expand profile
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
