"use client";

import { ReactNode } from "react";

// Shared HUD design language (clip shapes + helpers live in globals.css).
export const EDGE = "from-cyan-400/70 via-fuchsia-500/35 to-cyan-500/40";
export const EDGE_ACTIVE = "from-cyan-300/90 via-fuchsia-400/70 to-lime-300/60";
export const PANEL_BG = "bg-[#0b0713]/85 backdrop-blur-md";

export const glassTooltip = {
  background: "rgba(11,7,19,0.94)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "8px",
  fontSize: "12px",
  backdropFilter: "blur(8px)",
  color: "#e2e8f0",
};

/**
 * Layered poly-panel: an outer clipped gradient rim (the "border" that
 * follows the polygon) wrapping an identically-clipped dark glass inner.
 * Entrance transform sits on a separate wrapper so it never fights the
 * hover-lift transform.
 */
export function Panel({
  children,
  clip = "clip-panel",
  edge = EDGE,
  className = "",
  delay = 0,
  glow = true,
  interactive = true,
}: {
  children: ReactNode;
  clip?: string;
  edge?: string;
  className?: string;
  delay?: number;
  glow?: boolean;
  interactive?: boolean;
}) {
  return (
    <div className="animate-unfold" style={{ animationDelay: `${delay}ms` }}>
      <div
        className={`relative ${clip} p-[1.5px] bg-gradient-to-br ${edge} ${
          glow ? "hud-glow" : ""
        } transition-[transform,filter] duration-300 ${
          interactive ? "hover:-translate-y-1" : ""
        }`}
      >
        <div className={`relative ${clip} ${PANEL_BG} hud-scanlines ${className}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function PolyTile({
  children,
  clip = "clip-tile",
  className = "",
  delay = 0,
  active = false,
}: {
  children: ReactNode;
  clip?: string;
  className?: string;
  delay?: number;
  active?: boolean;
}) {
  return (
    <div className="animate-unfold" style={{ animationDelay: `${delay}ms` }}>
      <div
        className={`relative ${clip} p-px bg-gradient-to-br transition-[transform,filter] duration-300 hover:-translate-y-1 ${
          active ? `${EDGE_ACTIVE} hud-glow` : "from-white/15 to-white/5"
        }`}
      >
        <div className={`relative ${clip} ${PANEL_BG} hud-scanlines ${className}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

// Glowing geometric connector between stacked panels.
export function VConnector({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="relative h-7 flex justify-center animate-unfold"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="w-px h-full bg-gradient-to-b from-cyan-400/70 via-fuchsia-500/40 to-cyan-400/5" />
      <span className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rotate-45 bg-[#0b0713] border border-cyan-400/80 shadow-[0_0_12px_rgba(34,211,238,0.8)]" />
    </div>
  );
}

// Vertical accent rail used inside databank-style panels.
export function AccentRail({
  gradient = "from-cyan-400 via-cyan-300 to-fuchsia-500",
}: {
  gradient?: string;
}) {
  return (
    <span
      className={`pointer-events-none absolute left-0 top-6 bottom-6 w-[3px] rounded-full bg-gradient-to-b ${gradient} shadow-[0_0_14px_rgba(34,211,238,0.7)]`}
    />
  );
}
