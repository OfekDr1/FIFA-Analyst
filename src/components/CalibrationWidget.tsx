"use client";

import { useMemo } from "react";
import {
  Gauge,
  TrendingUp,
  TrendingDown,
  Minus,
  Hash,
  Scale,
} from "lucide-react";
import { Match, Team } from "@/types";
import { computeCalibration, type CalibrationBin } from "@/lib/calibration";
import { Panel, PolyTile } from "@/components/Hud";

interface Props {
  teams: Team[];
  matches: Match[];
}

// <0.55 strong, ≤0.667 beats the no-skill guess, above = worse than guessing
function brierColor(b: number): string {
  if (b <= 0.55) return "#34d399"; // emerald
  if (b <= 0.667) return "#38bdf8"; // sky
  return "#fb7185"; // rose
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-1.5">
      <span className="w-16 text-[10px] uppercase tracking-wide text-slate-500 shrink-0">
        {label}
      </span>
      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${Math.min(100, value)}%`,
            backgroundImage: `linear-gradient(90deg, ${color}80, ${color})`,
            boxShadow: `0 0 12px -1px ${color}cc`,
          }}
        />
      </div>
      <span className="w-10 text-right text-xs font-mono font-bold" style={{ color }}>
        {value.toFixed(0)}%
      </span>
    </div>
  );
}

function BinRow({ bin, index }: { bin: CalibrationBin; index: number }) {
  const expected = bin.avgPredicted * 100;
  const actual = bin.actualRate * 100;
  const diff = bin.actualRate - bin.avgPredicted; // + under, − overconfident
  const empty = bin.count === 0;
  const calibrated = Math.abs(diff) < 0.05;
  const over = diff < 0;

  const status = empty
    ? "No samples"
    : calibrated
      ? "Calibrated"
      : over
        ? "Overconfident"
        : "Underconfident";
  const sColor = empty
    ? "#64748b"
    : calibrated
      ? "#34d399"
      : over
        ? "#fb7185"
        : "#38bdf8";
  const SIcon = empty || calibrated ? Minus : over ? TrendingDown : TrendingUp;

  return (
    <div
      className="animate-unfold rounded-tl-2xl rounded-br-2xl rounded-tr-sm rounded-bl-sm bg-white/[0.02] border border-white/10 p-4"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-extrabold font-mono text-slate-100">
          {bin.label}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {bin.count} {bin.count === 1 ? "sample" : "samples"}
        </span>
      </div>

      {empty ? (
        <p className="text-xs text-slate-600 py-2">
          No win predictions landed in this probability range.
        </p>
      ) : (
        <>
          <Bar label="Expected" value={expected} color="#38bdf8" />
          <Bar label="Actual" value={actual} color="#34d399" />
          <div className="flex justify-end mt-2">
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold"
              style={{
                color: sColor,
                backgroundColor: `${sColor}14`,
                boxShadow: `0 0 12px -6px ${sColor}`,
              }}
            >
              <SIcon className="w-3 h-3" />
              {status}
              {!empty && !calibrated && (
                <span className="font-mono">
                  {diff > 0 ? "+" : ""}
                  {(diff * 100).toFixed(0)}%
                </span>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  color,
  clip,
  delay,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  sub: string;
  color: string;
  clip: string;
  delay: number;
}) {
  return (
    <PolyTile clip={clip} delay={delay} className="p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-wider text-slate-400">
          {label}
        </span>
        <div
          className="grid place-items-center w-9 h-9 clip-cell shrink-0"
          style={{ backgroundColor: `${color}1f`, boxShadow: `0 0 18px -6px ${color}` }}
        >
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      </div>
      <p
        className="text-4xl sm:text-5xl font-extrabold font-mono tabular-nums leading-none"
        style={{ color, textShadow: `0 0 26px ${color}55` }}
      >
        {value}
      </p>
      <p className="text-[11px] text-slate-500 mt-2">{sub}</p>
    </PolyTile>
  );
}

export function CalibrationWidget({ teams, matches }: Props) {
  const report = useMemo(() => computeCalibration(teams, matches), [teams, matches]);

  if (report.total === 0) {
    return (
      <div className="clip-tile bg-white/[0.02] border border-white/10 px-4 py-10 text-center text-sm text-slate-500">
        Not enough finished matches to diagnose calibration yet.
      </div>
    );
  }

  const bColor = brierColor(report.brierScore);

  return (
    <div className="space-y-6">
      <div className="animate-unfold">
        <h2 className="text-2xl font-extrabold tracking-tight flex items-center gap-2.5">
          <Gauge className="w-6 h-6 text-cyan-400" />
          <span className="bg-gradient-to-r from-white to-cyan-200 bg-clip-text text-transparent">
            Calibration &amp; Brier Score
          </span>
        </h2>
        <p className="text-sm text-slate-400 mt-1.5">
          Probabilistic accuracy of the engine&apos;s pre-match 1X2 calls
          (momentum &amp; Elo excluded to avoid leakage).
        </p>
      </div>

      {/* Headline metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatTile
          icon={Gauge}
          clip="clip-tile"
          delay={0}
          label="Brier Score"
          value={report.brierScore.toFixed(3)}
          sub="Closer to 0 is better"
          color={bColor}
        />
        <StatTile
          icon={Scale}
          clip="clip-tile-alt"
          delay={80}
          label="No-skill Baseline"
          value={report.baseline.toFixed(3)}
          sub="Uniform 1/3 guess — beat this"
          color="#94a3b8"
        />
        <StatTile
          icon={Hash}
          clip="clip-tile"
          delay={160}
          label="Matches Graded"
          value={String(report.total)}
          sub={`${report.samples} win-probability samples`}
          color="#a78bfa"
        />
      </div>

      {/* Reliability bins */}
      <Panel clip="clip-panel" delay={220} className="p-4 sm:p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
            Reliability — Expected vs Actual
          </h3>
          <div className="hidden sm:flex items-center gap-4 text-[10px] uppercase tracking-wider">
            <span className="flex items-center gap-1.5 text-sky-400">
              <span className="w-2.5 h-2.5 rounded-full bg-sky-400" /> Expected
            </span>
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Actual
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {report.bins.map((bin, i) => (
            <BinRow key={bin.label} bin={bin} index={i} />
          ))}
        </div>

        <p className="text-[11px] text-slate-500 mt-5 leading-relaxed">
          Each row pools Home- and Away-win predictions whose probability fell in
          that range. <span className="text-rose-300">Overconfident</span> = the
          model claimed more than reality delivered;{" "}
          <span className="text-sky-300">Underconfident</span> = it hedged too low.
          A perfectly calibrated model has Expected ≈ Actual in every band.
        </p>
      </Panel>
    </div>
  );
}
