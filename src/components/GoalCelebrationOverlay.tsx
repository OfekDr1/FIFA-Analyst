"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Zap } from "lucide-react";
import { Crest } from "@/components/Crest";
import type { GoalEvent } from "@/hooks/useLiveMatches";

// ─── Falling footballs across the whole viewport ───
function GoalConfetti({ goalKey }: { goalKey: number }) {
  const balls = useMemo(
    () =>
      Array.from({ length: 46 }).map((_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 1.2,
        dur: 2.4 + Math.random() * 2.4,
        drift: (Math.random() * 2 - 1) * 200,
        spin: (Math.random() * 2 - 1) * 900,
        size: 18 + Math.random() * 30,
      })),
    [goalKey]
  );

  return (
    <div className="fixed inset-0 z-[99999] pointer-events-none overflow-hidden">
      {balls.map((b) => {
        const style: CSSProperties = {
          left: `${b.left}%`,
          fontSize: `${b.size}px`,
          animationDuration: `${b.dur}s`,
          animationDelay: `${b.delay}s`,
          ["--drift" as string]: `${b.drift}px`,
          ["--spin" as string]: `${b.spin}deg`,
        } as CSSProperties;
        return (
          <span
            key={`${goalKey}-${b.id}`}
            className="falling-ball absolute top-0 select-none leading-none"
            style={style}
          >
            ⚽
          </span>
        );
      })}
    </div>
  );
}

// ─── Heroic 3D flag: massive in the center, flips, shrinks toward the banner ───
function HeroFlag({ goal }: { goal: GoalEvent }) {
  return (
    <div
      key={`hero-${goal.key}`}
      className="fixed inset-0 z-[99999] grid place-items-center pointer-events-none"
      style={{ perspective: "1200px" }}
    >
      <div className="animate-hero-flag relative">
        <div className="absolute inset-0 -z-10 rounded-full bg-emerald-400/30 blur-3xl scale-[2]" />
        <Crest crest={goal.crest} code={goal.tla} name={goal.teamName} size={180} glow />
      </div>
    </div>
  );
}

/**
 * Global goal-celebration takeover. Rendered via a portal straight into
 * <body> so it is immune to any dashboard clip-path / overflow-hidden /
 * backdrop-blur ancestor. Every layer is fixed to the viewport at a huge
 * z-index and pointer-events-none so it never blocks interaction.
 */
export function GoalCelebrationOverlay({ goal }: { goal: GoalEvent | null }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !goal) return null;

  return createPortal(
    <>
      {/* Dim + emerald vignette to sell the takeover */}
      <div
        key={`scrim-${goal.key}`}
        className="fixed inset-0 z-[99998] pointer-events-none animate-goal-scrim"
        style={{
          background:
            "radial-gradient(circle at 50% 38%, rgba(16,185,129,0.18), rgba(2,6,23,0.55) 70%)",
        }}
      />

      <GoalConfetti goalKey={goal.key} />
      <HeroFlag goal={goal} />

      {/* Broadcast banner — dark glass + emerald border, NO solid fill */}
      <div className="fixed left-1/2 top-[15%] -translate-x-1/2 z-[99999] w-[min(92vw,660px)] pointer-events-none">
        <div key={`banner-${goal.key}`} className="animate-goal-banner">
          <div className="relative rounded-2xl bg-black/80 backdrop-blur-2xl border border-emerald-400 shadow-[0_0_55px_-6px_rgba(16,185,129,0.75)] px-6 py-5 overflow-hidden flex items-center justify-center gap-4 animate-goal-glow">
            {/* scanline texture only — translucent, never a solid fill */}
            <span
              className="absolute inset-0 pointer-events-none opacity-25 mix-blend-screen"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(0deg, rgba(52,211,153,0.16) 0px, rgba(52,211,153,0.16) 1px, transparent 1px, transparent 3px)",
              }}
            />
            <Zap className="relative w-7 h-7 text-emerald-300 shrink-0" />
            <Crest crest={goal.crest} code={goal.tla} name={goal.teamName} size={40} glow />
            <div className="relative text-center">
              <p className="glitch-text font-extrabold tracking-[0.28em] text-emerald-200 uppercase text-xl sm:text-2xl leading-none">
                Goal Scoring Event
              </p>
              <p className="text-slate-100 font-bold mt-1.5">{goal.teamName}</p>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
