"use client";

import { Radio, Volume2, VolumeX } from "lucide-react";
import { Crest } from "@/components/Crest";
import type { LiveMatch, LiveTeam } from "@/hooks/useLiveMatches";

interface Props {
  matches: LiveMatch[];
  ready: boolean;
  muted: boolean;
  toggleMute: () => void;
}

function groupLabel(m: LiveMatch): string {
  if (m.group) return `Group ${m.group.replace(/^GROUP[_\s]?/i, "")}`;
  return m.stage.replace(/_/g, " ").toLowerCase();
}

function MuteButton({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={muted ? "Unmute goal sounds" : "Mute goal sounds"}
      aria-label={muted ? "Unmute goal sounds" : "Mute goal sounds"}
      className="grid place-items-center w-8 h-8 clip-cell bg-white/5 border border-white/10 text-slate-400 hover:text-cyan-300 hover:border-cyan-400/40 transition-all duration-300"
    >
      {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
    </button>
  );
}

function TeamSide({ team, align }: { team: LiveTeam; align: "start" | "end" }) {
  const crest = <Crest crest={team.crest} code={team.tla} name={team.name} size={34} />;
  const name = (
    <span className="font-bold text-slate-100 truncate text-sm sm:text-base">
      {team.name}
    </span>
  );
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${align === "end" ? "justify-end" : "justify-start"}`}>
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

function LiveCard({ match }: { match: LiveMatch }) {
  return (
    <div className="relative clip-panel p-[1.5px] bg-gradient-to-br from-cyan-400/70 via-fuchsia-500/35 to-cyan-500/40 hud-glow transition-all duration-300">
      <div className="relative clip-panel bg-[#0b0713]/90 backdrop-blur-md hud-scanlines p-3 sm:p-5">
        <div className="relative flex items-center justify-between mb-4">
          <span className="flex items-center gap-1.5 text-xs font-bold text-rose-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            LIVE
            {match.status === "PAUSED" ? " · HT" : match.minute ? ` · ${match.minute}'` : ""}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">
            {groupLabel(match)}
          </span>
        </div>

        <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3">
          <TeamSide team={match.home} align="end" />
          <div className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 clip-cell bg-black/50 border border-white/10">
            <span className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-slate-50">
              {match.score.home}
            </span>
            <span className="text-slate-600 font-bold">:</span>
            <span className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-slate-50">
              {match.score.away}
            </span>
          </div>
          <TeamSide team={match.away} align="start" />
        </div>
      </div>
    </div>
  );
}

/**
 * Presentational live-match strip. All polling/goal/audio logic lives in
 * useLiveMatches; the goal celebration is a separate global overlay, so the
 * cards here never change appearance when a goal is scored.
 */
export function LiveMatchTracker({ matches, ready, muted, toggleMute }: Props) {
  if (!ready) return null;

  if (matches.length === 0) {
    return (
      <div className="mb-6 clip-tile bg-white/[0.02] border border-white/10 px-4 py-2.5 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-slate-600" />
          <span className="uppercase tracking-wider">No Active Transmissions</span>
        </span>
        <MuteButton muted={muted} onToggle={toggleMute} />
      </div>
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
          <Radio className="w-3.5 h-3.5 text-rose-400" />
          Live Transmissions
        </span>
        <MuteButton muted={muted} onToggle={toggleMute} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {matches.map((m) => (
          <LiveCard key={m.id} match={m} />
        ))}
      </div>
    </div>
  );
}
