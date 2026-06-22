"use client";

import { useMemo, type ElementType } from "react";
import {
  Crosshair,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Target,
  Info,
} from "lucide-react";
import { Match, Team } from "@/types";
import {
  evaluatePredictions,
  type AccuracyStats,
  type MatchPredictionReview,
  type PredictionOutcome,
} from "@/lib/accuracy";
import { Crest } from "@/components/Crest";
import { PolyTile, PANEL_BG } from "@/components/Hud";

interface Props {
  teams: Team[];
  matches: Match[];
}

const OUTCOME: Record<
  PredictionOutcome,
  { label: string; color: string; icon: ElementType; edge: string; glow: boolean }
> = {
  exact: {
    label: "Exact",
    color: "#34d399",
    icon: CheckCircle2,
    edge: "from-emerald-400/80 via-cyan-400/40 to-emerald-400/30",
    glow: true,
  },
  trend: {
    label: "Trend",
    color: "#38bdf8", // sky blue — correct outcome, wrong scoreline
    icon: TrendingUp,
    edge: "from-sky-400/70 via-cyan-400/30 to-sky-500/30",
    glow: true,
  },
  miss: {
    label: "Miss",
    color: "#fb7185",
    icon: XCircle,
    edge: "from-rose-500/60 via-rose-400/25 to-white/5",
    glow: false,
  },
};

function PercentPanel({
  label,
  detail,
  value,
  color,
  icon: Icon,
  clip,
  delay,
}: {
  label: string;
  detail: string;
  value: number;
  color: string;
  icon: ElementType;
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
        {value.toFixed(1)}
        <span className="text-2xl align-top">%</span>
      </p>

      <div className="mt-3 h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${value}%`,
            backgroundImage: `linear-gradient(90deg, ${color}80, ${color})`,
            boxShadow: `0 0 12px -1px ${color}cc`,
          }}
        />
      </div>

      <p className="text-[11px] text-slate-500 mt-2">{detail}</p>
    </PolyTile>
  );
}

export function AccuracyWidget({ stats }: { stats: AccuracyStats }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <PercentPanel
        clip="clip-tile"
        delay={0}
        label="Trend Accuracy · 1X2"
        value={stats.trendAccuracy}
        detail={`${stats.trendCount} of ${stats.total} results called correctly`}
        color="#38bdf8"
        icon={TrendingUp}
      />
      <PercentPanel
        clip="clip-tile-alt"
        delay={80}
        label="Exact Score"
        value={stats.exactAccuracy}
        detail={`${stats.exactCount} of ${stats.total} scorelines nailed`}
        color="#34d399"
        icon={Crosshair}
      />
    </div>
  );
}

function TeamSide({
  team,
  align,
}: {
  team: MatchPredictionReview["home"];
  align: "start" | "end";
}) {
  const crest = <Crest crest={team.crest} flag={team.flag} name={team.name} size={28} />;
  const name = (
    <span className="font-semibold text-slate-100 truncate text-xs sm:text-sm">
      {team.name}
    </span>
  );
  return (
    <div className={`flex items-center gap-2 min-w-0 ${align === "end" ? "justify-end" : "justify-start"}`}>
      {align === "end" ? (
        <>
          {name}
          {crest}
        </>
      ) : (
        <>
          {crest}
          {name}
        </>
      )}
    </div>
  );
}

function ReviewCard({ r, index }: { r: MatchPredictionReview; index: number }) {
  const meta = OUTCOME[r.outcome];
  const Icon = meta.icon;
  const clip = index % 2 === 0 ? "clip-tile" : "clip-tile-alt";

  return (
    <div className="animate-unfold" style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}>
      <div
        className={`relative ${clip} p-px bg-gradient-to-br ${meta.edge} ${
          meta.glow ? "hud-glow" : ""
        } transition-[transform,filter] duration-300 hover:-translate-y-0.5`}
      >
        <div className={`relative ${clip} ${PANEL_BG} hud-scanlines p-4`}>
          {/* Meta row */}
          <div className="flex items-center justify-between mb-3 text-[10px] uppercase tracking-wider text-slate-500">
            <span>
              {new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
            <span>{r.stage.replace("-", " ")}</span>
          </div>

          {/* Teams + scores */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <TeamSide team={r.home} align="end" />

            <div className="text-center px-1.5 sm:px-2">
              <div className="text-[10px] text-slate-500 uppercase tracking-wide whitespace-nowrap">
                Pred {r.predicted.home}-{r.predicted.away}
              </div>
              <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums text-slate-50">
                {r.actual.home}
                <span className="text-slate-600 mx-1">-</span>
                {r.actual.away}
              </div>
            </div>

            <TeamSide team={r.away} align="start" />
          </div>

          {/* Outcome badge */}
          <div
            className="mt-3 flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wider"
            style={{ color: meta.color }}
          >
            <Icon className="w-4 h-4" />
            {meta.label}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PastMatchesList({ reviews }: { reviews: MatchPredictionReview[] }) {
  if (reviews.length === 0) {
    return (
      <div className="clip-tile bg-white/[0.02] border border-white/10 px-4 py-10 text-center text-sm text-slate-500">
        No finished matches to grade yet.
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-bold text-slate-100 mb-4 uppercase tracking-wider">
        Past Matches
      </h3>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {reviews.map((r, i) => (
          <ReviewCard key={r.matchId} r={r} index={i} />
        ))}
      </div>
    </div>
  );
}

export function PredictionAccuracy({ teams, matches }: Props) {
  // Compute lazily — only when this tab is mounted. O(n²) but n is small.
  const stats = useMemo(() => evaluatePredictions(teams, matches), [teams, matches]);

  return (
    <div className="space-y-8">
      <div className="animate-unfold">
        <h2 className="text-2xl font-extrabold tracking-tight flex items-center gap-2.5">
          <Target className="w-6 h-6 text-emerald-400" />
          <span className="bg-gradient-to-r from-white to-emerald-200 bg-clip-text text-transparent">
            Prediction Accuracy
          </span>
        </h2>
        <p className="text-sm text-slate-400 mt-1.5">
          How the Poisson engine&apos;s pre-match calls held up against real
          results.
        </p>
      </div>

      {stats.total === 0 ? (
        <div className="clip-tile bg-white/[0.02] border border-white/10 px-4 py-10 text-center text-sm text-slate-500">
          No finished matches to grade yet.
        </div>
      ) : (
        <>
          <AccuracyWidget stats={stats} />

          <PastMatchesList reviews={stats.reviews} />

          <div className="flex items-start gap-2.5 text-xs text-slate-500 rounded-xl bg-white/5 border border-white/10 p-4">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="leading-relaxed">
              Each match is graded against the prediction the engine would have
              made beforehand — generated using only matches that finished before
              its kickoff, so a match never informs its own forecast.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
