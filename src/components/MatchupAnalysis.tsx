"use client";

/**
 * MatchupAnalysis — the "Tale of the Tape" deep-dive.
 *
 * A broadcast-grade head-to-head panel for a single fixture. Pulls every signal
 * the backend exports (Elo, momentum, attack/defence xG, goal-difference form,
 * head-to-head dominance, and the learned 1X2 verdict) and stages them as:
 *   • an animated probability "verdict" bar,
 *   • a tug-of-war stat comparison (the divider slides toward the stronger side),
 *   • a head-to-head rivalry readout,
 *   • count-up numbers + fire indicators for teams in scorching form.
 *
 * Zero external animation deps — a small rAF count-up hook + CSS transitions do
 * all the motion, so it stays consistent with the app's CSS-driven HUD.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Flame,
  Gauge,
  Swords,
  ShieldHalf,
  Activity,
  Crown,
  Sparkles,
  Swords as Versus,
  History,
} from "lucide-react";
import { Team } from "@/types";
import { Crest } from "@/components/Crest";
import {
  loadMomentumScores,
  getEloRating,
  getMomentumScore,
  getTeamXg,
  getGoalDiffForm,
  getHeadToHead,
  getOutcomeProbabilities,
} from "@/lib/predictions";

// ── Team accent palette ──────────────────────────────────────────────
const HOME = "#22d3ee"; // cyan-400
const AWAY = "#fb7185"; // rose-400
const HOME_RGB = "34,211,238";
const AWAY_RGB = "251,113,133";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── rAF count-up: animates 0 → target whenever `play`/target changes ──
function useCountUp(target: number, play: boolean, duration = 1100): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!play) {
      setVal(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, play, duration]);
  return val;
}

// ── Stat descriptor ──────────────────────────────────────────────────
interface StatDef {
  key: string;
  label: string;
  Icon: typeof Gauge;
  home: number;
  away: number;
  scale: number; // gap that counts as "total domination" → caps the bar
  higherBetter: boolean;
  fmt: (v: number) => string;
}

/** Signed advantage in [-1, 1]; positive = home stronger. */
function advantage(s: StatDef): number {
  const diff = s.higherBetter ? s.home - s.away : s.away - s.home;
  return clamp(diff / s.scale, -1, 1);
}

// ── One comparative stat row (the tug-of-war) ────────────────────────
function StatRow({ stat, revealed }: { stat: StatDef; revealed: boolean }) {
  const homeVal = useCountUp(stat.home, revealed);
  const awayVal = useCountUp(stat.away, revealed);

  const adv = advantage(stat);
  const homePct = revealed ? clamp(50 + adv * 50, 6, 94) : 50;
  const homeWins = adv > 0.012;
  const awayWins = adv < -0.012;
  const { Icon } = stat;

  return (
    <div className="group">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span
          className="font-mono text-xl font-bold tabular-nums transition-colors"
          style={{
            color: homeWins ? HOME : "rgba(255,255,255,0.55)",
            textShadow: homeWins ? `0 0 18px rgba(${HOME_RGB},0.55)` : "none",
          }}
        >
          {stat.fmt(homeVal)}
        </span>

        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">
          <Icon className="h-3.5 w-3.5 text-white/35" />
          {stat.label}
        </span>

        <span
          className="font-mono text-xl font-bold tabular-nums transition-colors"
          style={{
            color: awayWins ? AWAY : "rgba(255,255,255,0.55)",
            textShadow: awayWins ? `0 0 18px rgba(${AWAY_RGB},0.55)` : "none",
          }}
        >
          {stat.fmt(awayVal)}
        </span>
      </div>

      {/* Tug-of-war track */}
      <div className="relative h-2.5 overflow-visible rounded-full bg-white/[0.05] ring-1 ring-inset ring-white/[0.06]">
        <div
          className="absolute inset-y-0 left-0 rounded-l-full transition-[width] duration-[900ms] ease-out"
          style={{
            width: `${homePct}%`,
            background: `linear-gradient(90deg, rgba(${HOME_RGB},0.12), rgba(${HOME_RGB},0.9))`,
          }}
        />
        <div
          className="absolute inset-y-0 right-0 rounded-r-full transition-[width] duration-[900ms] ease-out"
          style={{
            width: `${100 - homePct}%`,
            background: `linear-gradient(270deg, rgba(${AWAY_RGB},0.12), rgba(${AWAY_RGB},0.9))`,
          }}
        />
        {/* Divider knob — glows in the winner's colour */}
        <div
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-[#0a0e1a] transition-[left] duration-[900ms] ease-out"
          style={{
            left: `${homePct}%`,
            boxShadow: homeWins
              ? `0 0 14px 1px rgba(${HOME_RGB},0.8)`
              : awayWins
              ? `0 0 14px 1px rgba(${AWAY_RGB},0.8)`
              : "0 0 8px rgba(255,255,255,0.3)",
          }}
        />
      </div>
    </div>
  );
}

// ── Fire badge for teams in scorching momentum ───────────────────────
function FireBadge({ momentum }: { momentum: number }) {
  if (momentum < 70) return null;
  const blazing = momentum >= 85;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        blazing
          ? "animate-pulse border-orange-400/50 bg-orange-500/15 text-orange-300"
          : "border-amber-400/40 bg-amber-500/10 text-amber-300"
      }`}
    >
      <Flame className="h-3 w-3" />
      {blazing ? "On Fire" : "Hot"}
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────
export default function MatchupAnalysis({
  home,
  away,
}: {
  home: Team;
  away: Team;
}) {
  const [loaded, setLoaded] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadMomentumScores().then(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  // Re-stage the reveal whenever the fixture changes (or data lands).
  useEffect(() => {
    setRevealed(false);
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, [home.id, away.id, loaded]);

  const stats: StatDef[] = useMemo(() => {
    const hx = getTeamXg(home.name);
    const ax = getTeamXg(away.name);
    return [
      {
        key: "elo",
        label: "Elo",
        Icon: Gauge,
        home: getEloRating(home.name),
        away: getEloRating(away.name),
        scale: 300,
        higherBetter: true,
        fmt: (v) => Math.round(v).toString(),
      },
      {
        key: "mom",
        label: "Momentum",
        Icon: Flame,
        home: getMomentumScore(home.name),
        away: getMomentumScore(away.name),
        scale: 35,
        higherBetter: true,
        fmt: (v) => v.toFixed(0),
      },
      {
        key: "atk",
        label: "Attack xG",
        Icon: Swords,
        home: hx.xg,
        away: ax.xg,
        scale: 1.1,
        higherBetter: true,
        fmt: (v) => v.toFixed(2),
      },
      {
        key: "def",
        label: "Defense xGA",
        Icon: ShieldHalf,
        home: hx.xga,
        away: ax.xga,
        scale: 1.1,
        higherBetter: false, // fewer goals conceded is better
        fmt: (v) => v.toFixed(2),
      },
      {
        key: "form",
        label: "GD Form",
        Icon: Activity,
        home: getGoalDiffForm(home.name),
        away: getGoalDiffForm(away.name),
        scale: 7,
        higherBetter: true,
        fmt: (v) => (v > 0 ? `+${Math.round(v)}` : Math.round(v).toString()),
      },
    ];
  }, [home.name, away.name, loaded]);

  // Category tally (the "tale of the tape" scoreline).
  const homeEdges = stats.filter((s) => advantage(s) > 0.012).length;
  const awayEdges = stats.filter((s) => advantage(s) < -0.012).length;

  const homeMomentum = getMomentumScore(home.name);
  const awayMomentum = getMomentumScore(away.name);

  // Head-to-head rivalry.
  const h2h = useMemo(
    () => getHeadToHead(home.name, away.name),
    [home.name, away.name, loaded]
  );

  // Learned 1X2 verdict (falls back to an even split if the matchup is absent).
  const raw = getOutcomeProbabilities(home, away);
  const probsReady = !!raw;
  const probs = raw ?? { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

  const pHome = useCountUp(probs.home * 100, revealed && probsReady, 1200);
  const pDraw = useCountUp(probs.draw * 100, revealed && probsReady, 1200);
  const pAway = useCountUp(probs.away * 100, revealed && probsReady, 1200);

  const favHome = probs.home >= probs.away;
  const favTeam = favHome ? home : away;
  const favPct = Math.round((favHome ? probs.home : probs.away) * 100);
  const tooClose = Math.abs(probs.home - probs.away) < 0.05;
  const drawLikely = probs.draw >= probs.home && probs.draw >= probs.away;
  const headline = !probsReady
    ? "Crunching the model…"
    : drawLikely
    ? "Deadlock on the cards"
    : tooClose
    ? "Too close to call"
    : `${favTeam.name} favoured`;

  if (!loaded) {
    return (
      <div className="animate-pulse rounded-3xl border border-white/10 bg-[#0a0e1a]/60 p-8">
        <div className="mx-auto h-4 w-48 rounded bg-white/10" />
        <div className="mt-6 space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-2.5 rounded-full bg-white/5" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0c1120]/80 to-[#070a14]/90 backdrop-blur-xl">
      {/* Ambient corner glows */}
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full blur-3xl"
        style={{ background: `radial-gradient(circle, rgba(${HOME_RGB},0.18), transparent 70%)` }}
      />
      <div
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full blur-3xl"
        style={{ background: `radial-gradient(circle, rgba(${AWAY_RGB},0.18), transparent 70%)` }}
      />

      <div className="relative p-6 sm:p-8">
        {/* ── Hero: crest vs crest ── */}
        <div className="flex items-center justify-between gap-4">
          {/* Home */}
          <div
            className="flex flex-1 flex-col items-center gap-2 transition-all duration-700"
            style={{
              opacity: revealed ? 1 : 0,
              transform: revealed ? "translateX(0)" : "translateX(-24px)",
            }}
          >
            <Crest
              crest={home.crest}
              flag={home.flag}
              code={home.code}
              name={home.name}
              size={68}
              glow
            />
            <span className="text-center text-sm font-bold text-white">{home.name}</span>
            <FireBadge momentum={homeMomentum} />
          </div>

          {/* VS core */}
          <div className="flex flex-col items-center gap-2">
            <div
              className="relative flex h-14 w-14 items-center justify-center rounded-full border border-white/15 bg-white/[0.04]"
              style={{ boxShadow: "0 0 30px -8px rgba(255,255,255,0.4)" }}
            >
              <Versus className="h-6 w-6 rotate-90 text-white/80" />
            </div>
            <span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/35">
              Matchup
            </span>
          </div>

          {/* Away */}
          <div
            className="flex flex-1 flex-col items-center gap-2 transition-all duration-700"
            style={{
              opacity: revealed ? 1 : 0,
              transform: revealed ? "translateX(0)" : "translateX(24px)",
            }}
          >
            <Crest
              crest={away.crest}
              flag={away.flag}
              code={away.code}
              name={away.name}
              size={68}
              glow
            />
            <span className="text-center text-sm font-bold text-white">{away.name}</span>
            <FireBadge momentum={awayMomentum} />
          </div>
        </div>

        {/* ── Verdict bar ── */}
        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">
              <Sparkles className="h-3.5 w-3.5 text-fuchsia-300/70" />
              Model Verdict
            </span>
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/70">
              {headline}
              {probsReady && !drawLikely && !tooClose && (
                <span className="ml-1.5 text-white/40">{favPct}%</span>
              )}
            </span>
          </div>

          <div className="flex h-9 overflow-hidden rounded-xl ring-1 ring-white/10">
            <div
              className="flex items-center justify-start pl-2.5 text-xs font-bold text-[#06111a] transition-[width] duration-[1000ms] ease-out"
              style={{
                width: revealed ? `${probs.home * 100}%` : "33.333%",
                background: `linear-gradient(90deg, rgba(${HOME_RGB},0.85), rgba(${HOME_RGB},1))`,
              }}
            >
              {pHome >= 8 && <span className="tabular-nums">{pHome.toFixed(0)}%</span>}
            </div>
            <div
              className="flex items-center justify-center bg-white/[0.08] text-xs font-bold text-white/60 transition-[width] duration-[1000ms] ease-out"
              style={{ width: revealed ? `${probs.draw * 100}%` : "33.333%" }}
            >
              {pDraw >= 8 && <span className="tabular-nums">{pDraw.toFixed(0)}%</span>}
            </div>
            <div
              className="flex items-center justify-end pr-2.5 text-xs font-bold text-[#1a0610] transition-[width] duration-[1000ms] ease-out"
              style={{
                width: revealed ? `${probs.away * 100}%` : "33.333%",
                background: `linear-gradient(270deg, rgba(${AWAY_RGB},0.85), rgba(${AWAY_RGB},1))`,
              }}
            >
              {pAway >= 8 && <span className="tabular-nums">{pAway.toFixed(0)}%</span>}
            </div>
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] font-medium uppercase tracking-wider text-white/35">
            <span>Win</span>
            <span>Draw</span>
            <span>Win</span>
          </div>
        </div>

        {/* ── Tale of the tape ── */}
        <div className="mt-8">
          <div className="mb-4 flex items-center justify-center gap-3">
            <EdgePill side="home" wins={homeEdges} lead={homeEdges > awayEdges} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
              Tale of the Tape
            </span>
            <EdgePill side="away" wins={awayEdges} lead={awayEdges > homeEdges} />
          </div>

          <div className="space-y-5">
            {stats.map((s, i) => (
              <div
                key={s.key}
                className="transition-all duration-700"
                style={{
                  opacity: revealed ? 1 : 0,
                  transform: revealed ? "translateY(0)" : "translateY(12px)",
                  transitionDelay: `${120 + i * 80}ms`,
                }}
              >
                <StatRow stat={s} revealed={revealed} />
              </div>
            ))}
          </div>
        </div>

        {/* ── Head-to-head rivalry ── */}
        <div className="mt-8 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">
            <History className="h-3.5 w-3.5 text-white/35" />
            Head-to-Head
          </div>
          <H2HReadout home={home} away={away} h2h={h2h} />
        </div>
      </div>
    </div>
  );
}

// ── Category-edge pill ───────────────────────────────────────────────
function EdgePill({
  side,
  wins,
  lead,
}: {
  side: "home" | "away";
  wins: number;
  lead: boolean;
}) {
  const color = side === "home" ? HOME : AWAY;
  const rgb = side === "home" ? HOME_RGB : AWAY_RGB;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold tabular-nums"
      style={{
        color,
        borderColor: `rgba(${rgb},0.4)`,
        background: lead ? `rgba(${rgb},0.12)` : "transparent",
        boxShadow: lead ? `0 0 16px -4px rgba(${rgb},0.6)` : "none",
      }}
    >
      {lead && <Crown className="h-3 w-3" />}
      {wins}
    </span>
  );
}

// ── Head-to-head readout ─────────────────────────────────────────────
function H2HReadout({
  home,
  away,
  h2h,
}: {
  home: Team;
  away: Team;
  h2h: { gd: number; hasHistory: boolean };
}) {
  if (!h2h.hasHistory) {
    return (
      <p className="text-sm text-white/60">
        <span className="font-semibold text-white/80">Uncharted territory.</span> No
        recent meetings on record — history starts here.
      </p>
    );
  }

  const even = Math.abs(h2h.gd) < 0.25;
  if (even) {
    return (
      <p className="text-sm text-white/60">
        <span className="font-semibold text-white/80">Honours even.</span> These two
        have traded blows with nothing to separate them.
      </p>
    );
  }

  const homeDominant = h2h.gd > 0;
  const boss = homeDominant ? home : away;
  const color = homeDominant ? HOME : AWAY;
  const rgb = homeDominant ? HOME_RGB : AWAY_RGB;
  const mag = Math.abs(h2h.gd);
  const intensity =
    mag >= 2 ? "owns this fixture" : mag >= 1 ? "holds the upper hand" : "edges it";

  return (
    <div className="flex items-center gap-3">
      <Crest crest={boss.crest} flag={boss.flag} code={boss.code} name={boss.name} size={36} />
      <div className="min-w-0">
        <p className="text-sm text-white/75">
          <span className="font-bold" style={{ color }}>
            {boss.name}
          </span>{" "}
          {intensity}.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span
            className="rounded-md px-1.5 py-0.5 font-mono text-xs font-bold"
            style={{ color, background: `rgba(${rgb},0.12)` }}
          >
            {h2h.gd > 0 ? "+" : ""}
            {h2h.gd.toFixed(1)} avg GD
          </span>
          <span className="text-[11px] text-white/40">in recent meetings</span>
        </div>
      </div>
    </div>
  );
}
