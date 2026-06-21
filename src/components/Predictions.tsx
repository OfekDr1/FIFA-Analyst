"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Target,
  Sparkles,
  Info,
  CalendarClock,
} from "lucide-react";
import { Team, Match, UpcomingFixture } from "@/types";
import { predictMatch } from "@/lib/predictions";
import { Crest, flagSources } from "@/components/Crest";
import { Panel, PolyTile, VConnector, EDGE_ACTIVE, PANEL_BG } from "@/components/Hud";

interface Props {
  teams: Team[];
  matches: Match[];
  upcoming: UpcomingFixture[];
}

const COLOR_HOME = "#22d3ee";
const COLOR_DRAW = "#94a3b8";
const COLOR_AWAY = "#fb7185";

function TeamSelect({
  value,
  onChange,
  teams,
}: {
  value: string;
  onChange: (id: string) => void;
  teams: Team[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full clip-tile bg-white/5 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/40 transition-all"
    >
      {teams.map((t) => (
        <option key={t.id} value={t.id} className="bg-slate-900">
          {t.name}
        </option>
      ))}
    </select>
  );
}

function ProbabilityBar({
  home,
  draw,
  away,
}: {
  home: number;
  draw: number;
  away: number;
}) {
  const seg = (w: number, color: string, glow: string) => (
    <div
      className="flex items-center justify-center text-xs font-bold text-slate-950 transition-all duration-700"
      style={{
        width: `${w}%`,
        backgroundImage: `linear-gradient(180deg, ${color}, ${color}bb)`,
        boxShadow: `inset 0 0 22px ${glow}`,
      }}
    >
      {w >= 9 ? `${w.toFixed(0)}%` : ""}
    </div>
  );

  return (
    <div>
      <div className="clip-tile flex h-12 overflow-hidden">
        {seg(home, COLOR_HOME, "rgba(34,211,238,0.8)")}
        {seg(draw, COLOR_DRAW, "rgba(148,163,184,0.55)")}
        {seg(away, COLOR_AWAY, "rgba(251,113,133,0.8)")}
      </div>
      <div className="flex justify-between mt-2.5 text-xs font-semibold">
        <span style={{ color: COLOR_HOME }}>Home {home.toFixed(1)}%</span>
        <span style={{ color: COLOR_DRAW }}>Draw {draw.toFixed(1)}%</span>
        <span style={{ color: COLOR_AWAY }}>Away {away.toFixed(1)}%</span>
      </div>
    </div>
  );
}

function heatColor(alpha: number): string {
  const t = Math.pow(Math.min(1, Math.max(0, alpha)), 0.62);
  const cyan = [34, 211, 238];
  const emerald = [16, 185, 129];
  const lime = [163, 230, 53];
  let c1: number[], c2: number[], f: number;
  if (t < 0.6) {
    c1 = cyan;
    c2 = emerald;
    f = t / 0.6;
  } else {
    c1 = emerald;
    c2 = lime;
    f = (t - 0.6) / 0.4;
  }
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
  const op = 0.08 + t * 0.9;
  return `rgba(${r}, ${g}, ${b}, ${op.toFixed(3)})`;
}

function Heatmap({
  grid,
  homeTeam,
  awayTeam,
}: {
  grid: number[][];
  homeTeam: { flag: string; name: string; crest?: string };
  awayTeam: { flag: string; name: string; crest?: string };
}) {
  const SIZE = 6;
  let maxP = 0;
  let modal = { h: 0, a: 0 };
  for (let h = 0; h < SIZE; h++) {
    for (let a = 0; a < SIZE; a++) {
      const p = grid[h]?.[a] ?? 0;
      if (p > maxP) {
        maxP = p;
        modal = { h, a };
      }
    }
  }

  return (
    <div className="clip-panel p-px bg-gradient-to-br from-white/15 to-white/5 inline-block">
      <div className="clip-panel relative bg-black/50 backdrop-blur-md p-3 sm:p-5">
        <div className="flex items-center gap-2 mb-3 ml-9 sm:ml-14 text-xs text-slate-400">
          <Crest crest={awayTeam.crest} flag={awayTeam.flag} name={awayTeam.name} size={22} />
          <span className="font-semibold">{awayTeam.name} goals →</span>
        </div>

        <div className="flex">
          <div className="flex items-center justify-center mr-1 w-6 sm:w-8">
            <span className="flex items-center gap-1.5 -rotate-90 whitespace-nowrap text-[10px] sm:text-xs text-slate-400 font-semibold">
              {homeTeam.name} goals
            </span>
          </div>

          <div>
            <div className="flex">
              <div className="w-7 sm:w-10 h-8" />
              {Array.from({ length: SIZE }).map((_, a) => (
                <div
                  key={a}
                  className="w-11 sm:w-14 h-8 grid place-items-center text-xs sm:text-sm font-bold text-slate-500"
                >
                  {a}
                </div>
              ))}
            </div>

            {Array.from({ length: SIZE }).map((_, h) => (
              <div key={h} className="flex">
                <div className="w-7 sm:w-10 h-11 sm:h-14 grid place-items-center text-xs sm:text-sm font-bold text-slate-500">
                  {h}
                </div>
                {Array.from({ length: SIZE }).map((_, a) => {
                  const p = grid[h]?.[a] ?? 0;
                  const alpha = maxP > 0 ? p / maxP : 0;
                  const isModal = h === modal.h && a === modal.a;
                  return (
                    <div
                      key={a}
                      title={`${h}-${a}: ${p.toFixed(1)}%`}
                      className={`clip-cell w-11 sm:w-14 h-11 sm:h-14 m-0.5 grid place-items-center text-xs sm:text-sm font-mono font-bold transition-all duration-300 ${
                        isModal ? "scale-110 z-10" : "hover:scale-105"
                      }`}
                      style={{
                        backgroundColor: heatColor(alpha),
                        color: alpha > 0.45 ? "#020617" : "#475569",
                        filter: isModal
                          ? "drop-shadow(0 0 12px rgba(163,230,53,0.95))"
                          : undefined,
                      }}
                    >
                      {p >= 1 ? p.toFixed(0) : ""}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-slate-500 mt-4 max-w-md">
          Each cell = probability (%) of that exact scoreline. Brighter = more
          likely; the glowing cell is the single most probable result.
        </p>
      </div>
    </div>
  );
}

function FixtureTimeline({
  fixtures,
  teams,
  activePair,
  onSelect,
}: {
  fixtures: UpcomingFixture[];
  teams: Team[];
  activePair: [string, string];
  onSelect: (f: UpcomingFixture) => void;
}) {
  const getTeam = (id: string) => teams.find((t) => t.id === id);
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <Panel clip="clip-sidebar" interactive={false} delay={300} className="p-5">
      <h3 className="text-sm font-bold text-slate-100 mb-5 flex items-center gap-2 uppercase tracking-wider">
        <CalendarClock className="w-4 h-4 text-cyan-400" />
        Upcoming Fixtures
      </h3>

      {fixtures.length === 0 ? (
        <p className="text-xs text-slate-500 py-6 text-center">
          No upcoming fixtures available right now.
        </p>
      ) : (
        <div className="relative pl-6">
          <div className="absolute left-[8px] top-2 bottom-2 w-px bg-gradient-to-b from-cyan-400/60 via-fuchsia-500/30 to-transparent" />

          <div className="flex flex-col gap-3">
            {fixtures.map((f, i) => {
              const home = getTeam(f.homeTeamId);
              const away = getTeam(f.awayTeamId);
              const isActive =
                (activePair[0] === f.homeTeamId && activePair[1] === f.awayTeamId) ||
                (activePair[0] === f.awayTeamId && activePair[1] === f.homeTeamId);
              const clip = i % 2 === 0 ? "clip-tile" : "clip-tile-alt";

              return (
                <div
                  key={f.id}
                  className="relative animate-unfold"
                  style={{ animationDelay: `${450 + i * 90}ms` }}
                >
                  <span
                    className={`absolute -left-[20px] top-5 w-2.5 h-2.5 rotate-45 transition-all duration-300 ${
                      isActive
                        ? "bg-lime-300 shadow-[0_0_14px_2px_rgba(163,230,53,0.85)]"
                        : "bg-[#0b0713] border border-cyan-400/80 shadow-[0_0_10px_rgba(34,211,238,0.6)]"
                    }`}
                  />
                  <div
                    className={`relative ${clip} p-px bg-gradient-to-r transition-[transform,filter] duration-300 hover:-translate-y-0.5 ${
                      isActive
                        ? `${EDGE_ACTIVE} hud-glow`
                        : "from-white/15 to-white/5"
                    }`}
                  >
                    <button
                      onClick={() => onSelect(f)}
                      className={`relative w-full text-left ${clip} ${PANEL_BG} hud-scanlines p-3`}
                    >
                      <div className="flex items-center justify-between text-[10px] text-slate-500 mb-2.5">
                        <span>{fmt(f.kickoff)}</span>
                        <span className="uppercase tracking-wide">
                          {f.group ? `Group ${f.group}` : f.stage.replace("-", " ")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Crest crest={home?.crest} flag={home?.flag} code={home?.code} name={home?.name ?? ""} size={24} />
                          <span className="text-xs font-semibold text-slate-100 truncate">
                            {home?.name}
                          </span>
                        </div>
                        <span className="text-[10px] font-bold text-slate-600 shrink-0">
                          VS
                        </span>
                        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
                          <span className="text-xs font-semibold text-slate-100 truncate text-right">
                            {away?.name}
                          </span>
                          <Crest crest={away?.crest} flag={away?.flag} code={away?.code} name={away?.name ?? ""} size={24} />
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function Predictions({ teams, matches, upcoming }: Props) {
  const sorted = useMemo(
    () => [...teams].sort((a, b) => a.name.localeCompare(b.name)),
    [teams]
  );

  const [homeId, setHomeId] = useState(sorted[0]?.id ?? "");
  const [awayId, setAwayId] = useState(sorted[1]?.id ?? "");

  const homeTeam = sorted.find((t) => t.id === homeId);
  const awayTeam = sorted.find((t) => t.id === awayId);
  const sameTeam = homeId === awayId;

  const prediction = useMemo(() => {
    if (!homeTeam || !awayTeam || sameTeam) return null;
    return predictMatch(homeTeam, awayTeam, teams, matches);
  }, [homeTeam, awayTeam, sameTeam, teams, matches]);

  const swap = () => {
    setHomeId(awayId);
    setAwayId(homeId);
  };

  const loadFixture = (f: UpcomingFixture) => {
    setHomeId(f.homeTeamId);
    setAwayId(f.awayTeamId);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const homeFlag = homeTeam
    ? flagSources(homeTeam.flag, homeTeam.crest, homeTeam.code)[0]
    : undefined;
  const awayFlag = awayTeam
    ? flagSources(awayTeam.flag, awayTeam.crest, awayTeam.code)[0]
    : undefined;

  return (
    <div className="space-y-8">
      <div className="animate-unfold">
        <h2 className="text-2xl font-extrabold tracking-tight flex items-center gap-2.5">
          <Sparkles className="w-6 h-6 text-cyan-400" />
          <span className="bg-gradient-to-r from-white to-cyan-200 bg-clip-text text-transparent">
            Match Predictions
          </span>
        </h2>
        <p className="text-sm text-slate-400 mt-1.5">
          Poisson model grounded by FIFA ranking — pick a matchup or tap an
          upcoming fixture.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 sm:gap-6 items-start">
        {/* ── Engine column ── */}
        <div className="flex flex-col">
          {/* Matchup hero (large hex-cut tech panel) */}
          <Panel clip="clip-hero" delay={0} className="p-4 sm:p-8 overflow-hidden">
            {homeFlag && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={homeFlag}
                alt=""
                aria-hidden
                className="pointer-events-none absolute -left-16 -top-16 w-72 h-72 object-cover rounded-full opacity-[0.08] blur-[2px]"
              />
            )}
            {awayFlag && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={awayFlag}
                alt=""
                aria-hidden
                className="pointer-events-none absolute -right-16 -bottom-16 w-72 h-72 object-cover rounded-full opacity-[0.08] blur-[2px]"
              />
            )}

            <div className="relative grid grid-cols-[1fr_auto_1fr] gap-2 sm:gap-8 items-center">
              <div className="flex flex-col items-center gap-3">
                {homeTeam && (
                  <Crest crest={homeTeam.crest} flag={homeTeam.flag} code={homeTeam.code} name={homeTeam.name} size={84} glow />
                )}
                <TeamSelect value={homeId} onChange={setHomeId} teams={sorted} />
              </div>

              <button
                onClick={swap}
                className="grid place-items-center w-12 h-12 rounded-full bg-white/5 border border-white/10 text-slate-300 hover:text-cyan-300 hover:border-cyan-400/40 hover:rotate-180 transition-all duration-500"
                title="Swap teams"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>

              <div className="flex flex-col items-center gap-3">
                {awayTeam && (
                  <Crest crest={awayTeam.crest} flag={awayTeam.flag} code={awayTeam.code} name={awayTeam.name} size={84} glow />
                )}
                <TeamSelect value={awayId} onChange={setAwayId} teams={sorted} />
              </div>
            </div>

            {prediction && (
              <div className="relative mt-8 space-y-6">
                <ProbabilityBar
                  home={prediction.winProbability.home}
                  draw={prediction.winProbability.draw}
                  away={prediction.winProbability.away}
                />
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { team: prediction.homeTeam, xg: prediction.expectedGoals.home, color: COLOR_HOME, clip: "clip-tile" },
                    { team: prediction.awayTeam, xg: prediction.expectedGoals.away, color: COLOR_AWAY, clip: "clip-tile-alt" },
                  ].map((d, i) => (
                    <PolyTile key={i} clip={d.clip} delay={120 + i * 90} className="p-4 text-center">
                      <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                        Expected Goals λ
                      </p>
                      <p
                        className="text-4xl font-extrabold font-mono tabular-nums"
                        style={{ color: d.color, textShadow: `0 0 26px ${d.color}66` }}
                      >
                        {d.xg.toFixed(2)}
                      </p>
                      <div className="flex items-center justify-center gap-1.5 mt-2">
                        <Crest crest={d.team.crest} flag={d.team.flag} name={d.team.name} size={18} />
                        <span className="text-xs text-slate-400">{d.team.name}</span>
                      </div>
                    </PolyTile>
                  ))}
                </div>
              </div>
            )}

            {sameTeam && (
              <p className="relative mt-8 text-center text-slate-400 text-sm">
                Select two different teams to generate a prediction.
              </p>
            )}
          </Panel>

          {prediction && (
            <>
              <VConnector delay={220} />

              {/* Scorelines */}
              <Panel clip="clip-panel-alt" delay={260} className="p-4 sm:p-6">
                <h3 className="text-sm font-bold text-slate-100 mb-5 flex items-center gap-2 uppercase tracking-wider">
                  <Target className="w-4 h-4 text-cyan-400" />
                  Most Likely Scorelines
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {prediction.mostLikelyScores.map((s, i) => (
                    <PolyTile
                      key={`${s.home}-${s.away}`}
                      clip={i % 2 === 0 ? "clip-tile" : "clip-tile-alt"}
                      active={i === 0}
                      delay={340 + i * 80}
                      className="p-4 text-center"
                    >
                      <p
                        className="text-3xl font-extrabold font-mono text-slate-50"
                        style={i === 0 ? { textShadow: "0 0 20px rgba(34,211,238,0.65)" } : undefined}
                      >
                        {s.home}
                        <span className="text-slate-600 mx-1.5">:</span>
                        {s.away}
                      </p>
                      <p
                        className="text-xs font-bold mt-1.5"
                        style={{ color: i === 0 ? COLOR_HOME : "#94a3b8" }}
                      >
                        {(s.probability * 100).toFixed(1)}%
                      </p>
                    </PolyTile>
                  ))}
                </div>
              </Panel>

              <VConnector delay={520} />

              {/* Heatmap */}
              <Panel clip="clip-panel" delay={560} className="p-4 sm:p-6 overflow-x-auto">
                <h3 className="text-sm font-bold text-slate-100 mb-5 uppercase tracking-wider">
                  Scoreline Probability Heatmap
                </h3>
                <Heatmap
                  grid={prediction.scoreGrid}
                  homeTeam={prediction.homeTeam}
                  awayTeam={prediction.awayTeam}
                />
              </Panel>

              <VConnector delay={760} />

              {/* Disclaimer */}
              <Panel
                clip="clip-tile"
                delay={800}
                glow={false}
                interactive={false}
                className="p-4 flex items-start gap-2.5 text-xs text-slate-500"
              >
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">
                  Predictions blend recent form with FIFA ranking. On the free API
                  tier possession/xG/shots are estimated, so strengths reflect
                  scorelines more than underlying performance.
                </span>
              </Panel>
            </>
          )}
        </div>

        {/* ── Fixtures timeline sidebar (integrated via connector node) ── */}
        <aside className="relative lg:sticky lg:top-28">
          <span className="hidden lg:block absolute -left-3 top-12 w-3 h-px bg-gradient-to-l from-cyan-400/70 to-transparent" />
          <span className="hidden lg:block absolute -left-4 top-12 -translate-y-1/2 w-2 h-2 rotate-45 bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)]" />
          <FixtureTimeline
            fixtures={upcoming}
            teams={teams}
            activePair={[homeId, awayId]}
            onSelect={loadFixture}
          />
        </aside>
      </div>
    </div>
  );
}
