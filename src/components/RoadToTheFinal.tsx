"use client";

/**
 * RoadToTheFinal — a FiveThirtyEight-style LIVE advancement matrix.
 *
 * Reads public/tournament_sim.json (the live Monte-Carlo output) and renders a
 * sortable heatmap: one row per team, a column per knockout stage, every cell
 * shaded by the % chance to reach that stage. Now conditioned on reality —
 * shows current points / GD, fades eliminated teams, badges qualified ones, and
 * stamps the data "as of" the last played match. Click any header to sort.
 *
 * Self-contained — fetches its own data, so it can be dropped anywhere.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown, Trophy, Dice5, CheckCircle2 } from "lucide-react";
import { Crest } from "@/components/Crest";
import { flagUrl } from "@/data/flagCodes";

type Status = "eliminated" | "qualified" | "active";

interface SimTeam {
  team: string;
  group: string;
  elo: number;
  played?: number;
  points?: number;
  gd?: number;
  status?: Status;
  reach_r32: number;
  reach_r16: number;
  reach_qf: number;
  reach_sf: number;
  reach_final: number;
  win: number;
}
interface SimData {
  generated_at: string;
  as_of?: string | null;
  simulations: number;
  locked?: { group_matches: number; knockout_matches: number };
  format: string;
  teams: SimTeam[];
}

type SortKey =
  | keyof Pick<
      SimTeam,
      | "reach_r32" | "reach_r16" | "reach_qf" | "reach_sf" | "reach_final"
      | "win" | "elo" | "points" | "gd"
    >
  | "team";

const STAGE_COLS: { key: SortKey; label: string; hint: string }[] = [
  { key: "reach_r32", label: "R32", hint: "Reach the Round of 32" },
  { key: "reach_r16", label: "R16", hint: "Reach the Round of 16" },
  { key: "reach_qf", label: "QF", hint: "Reach the Quarter-finals" },
  { key: "reach_sf", label: "SF", hint: "Reach the Semi-finals" },
  { key: "reach_final", label: "Final", hint: "Reach the Final" },
  { key: "win", label: "Champion", hint: "Win the World Cup" },
];

// ── Formatting + heatmap ─────────────────────────────────────────────
function fmtPct(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p < 0.005) return p > 0 ? "<1%" : "—";
  return `${Math.round(p * 100)}%`;
}

function fmtGd(gd: number): string {
  return gd > 0 ? `+${gd}` : `${gd}`;
}

function fmtDate(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime())
    ? s
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Sequential heat: faint at low odds → vivid cyan-to-emerald at high odds. */
function cellStyle(p: number): React.CSSProperties {
  if (p <= 0) return { color: "rgba(255,255,255,0.2)" };
  const alpha = 0.1 + 0.8 * Math.pow(p, 0.7); // perceptual ramp (small odds still visible)
  const hue = 188 - 48 * p; // 188 (cyan) → 140 (emerald)
  return {
    background: `hsla(${hue}, 85%, 48%, ${alpha})`,
    color: p > 0.42 ? "#04121a" : "rgba(255,255,255,0.92)",
    fontWeight: p > 0.42 ? 700 : 500,
  };
}

// ── Status badge ─────────────────────────────────────────────────────
function StatusBadge({ status }: { status?: Status }) {
  if (status === "qualified")
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Through
      </span>
    );
  if (status === "eliminated")
    return (
      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-300/70">
        Out
      </span>
    );
  return null;
}

export default function RoadToTheFinal() {
  const [data, setData] = useState<SimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("win");
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    fetch(`/tournament_sim.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SimData | null) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    if (!data?.teams) return [];
    const sorted = [...data.teams].sort((a, b) => {
      if (sortKey === "team") return a.team.localeCompare(b.team);
      return ((a[sortKey] ?? 0) as number) - ((b[sortKey] ?? 0) as number);
    });
    return asc ? sorted : sorted.reverse();
  }, [data, sortKey, asc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAsc((v) => !v);
    } else {
      setSortKey(key);
      setAsc(key === "team"); // names default A→Z; numbers default high→low
    }
  }

  const SortIcon = ({ k }: { k: SortKey }) =>
    k !== sortKey ? (
      <span className="inline-block w-3" />
    ) : asc ? (
      <ChevronUp className="inline h-3 w-3" />
    ) : (
      <ChevronDown className="inline h-3 w-3" />
    );

  if (loading) {
    return (
      <div className="animate-pulse rounded-3xl border border-white/10 bg-[#0a0e1a]/60 p-8">
        <div className="h-5 w-56 rounded bg-white/10" />
        <div className="mt-6 space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-8 rounded bg-white/5" />
          ))}
        </div>
      </div>
    );
  }

  if (!data?.teams?.length) {
    return (
      <div className="rounded-3xl border border-white/10 bg-[#0a0e1a]/60 p-8 text-center">
        <Dice5 className="mx-auto h-8 w-8 text-white/30" />
        <p className="mt-3 text-sm text-white/60">
          No simulation data yet. Run{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-cyan-300">
            python scripts/simulate_tournament.py
          </code>{" "}
          to generate <code className="text-white/70">tournament_sim.json</code>.
        </p>
      </div>
    );
  }

  const lockedTotal =
    (data.locked?.group_matches ?? 0) + (data.locked?.knockout_matches ?? 0);
  const isLive = lockedTotal > 0;
  const asOf = fmtDate(data.as_of);

  return (
    <div className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0c1120]/80 to-[#070a14]/90 backdrop-blur-xl">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 p-5 sm:p-6">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-white">
            <Trophy className="h-4 w-4 text-amber-300" />
            Road to the Final
            {isLive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
                </span>
                Live
              </span>
            )}
          </h3>
          <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-white/40">
            {isLive ? `Conditioned on ${lockedTotal} played` : "Pre-tournament forecast"} ·{" "}
            {data.simulations.toLocaleString()} sims
          </p>
        </div>
        {/* Heat legend */}
        <div className="flex items-center gap-2 text-[10px] text-white/40">
          <span>0%</span>
          <div
            className="h-2 w-24 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, hsla(188,85%,48%,0.12), hsla(164,85%,48%,0.55), hsla(140,85%,48%,0.95))",
            }}
          />
          <span>100%</span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-white/45">
              <th className="sticky left-0 z-20 bg-[#0a0e1a] px-3 py-3 text-left">
                <button
                  onClick={() => toggleSort("team")}
                  className="flex items-center gap-1 transition-colors hover:text-white"
                >
                  Team <SortIcon k="team" />
                </button>
              </th>
              {([
                { key: "points", label: "Pts", hint: "Current group points (locked from real results)" },
                { key: "gd", label: "GD", hint: "Current goal difference" },
                { key: "elo", label: "Elo", hint: "Elo rating" },
              ] as { key: SortKey; label: string; hint: string }[]).map((c) => (
                <th key={c.key} className="px-3 py-3 text-right" title={c.hint}>
                  <button
                    onClick={() => toggleSort(c.key)}
                    className="ml-auto flex items-center gap-1 transition-colors hover:text-white"
                  >
                    {c.label} <SortIcon k={c.key} />
                  </button>
                </th>
              ))}
              {STAGE_COLS.map((c) => (
                <th key={c.key} className="px-2 py-3 text-center" title={c.hint}>
                  <button
                    onClick={() => toggleSort(c.key)}
                    className={`mx-auto flex items-center gap-1 transition-colors hover:text-white ${
                      c.key === sortKey ? "text-white" : ""
                    } ${c.key === "win" ? "text-amber-200" : ""}`}
                  >
                    {c.label} <SortIcon k={c.key} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const out = t.status === "eliminated";
              const through = t.status === "qualified";
              return (
                <tr
                  key={t.team}
                  className={`border-t border-white/[0.06] transition-colors hover:bg-white/[0.03] ${
                    out ? "opacity-40" : ""
                  }`}
                >
                  {/* Team (sticky) */}
                  <td
                    className="sticky left-0 z-10 bg-[#0a0e1a] px-3 py-2"
                    style={
                      through
                        ? { boxShadow: "inset 2px 0 0 rgba(52,211,153,0.6)" }
                        : undefined
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-5 text-right text-[11px] tabular-nums text-white/30">
                        {i + 1}
                      </span>
                      <Crest crest={flagUrl(t.team)} name={t.team} code={t.group} size={22} />
                      <span className="truncate font-medium text-white/90">{t.team}</span>
                      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-white/40">
                        {t.group}
                      </span>
                      <StatusBadge status={t.status} />
                    </div>
                  </td>
                  {/* Current standing */}
                  <td
                    className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-white/80"
                    title={`Played ${t.played ?? 0}`}
                  >
                    {t.points ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-white/50">
                    {fmtGd(t.gd ?? 0)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-white/40">
                    {t.elo}
                  </td>
                  {/* Stage heat cells */}
                  {STAGE_COLS.map((c) => (
                    <td
                      key={c.key}
                      className="px-2 py-2 text-center text-xs tabular-nums"
                      style={cellStyle(t[c.key] as number)}
                    >
                      {fmtPct(t[c.key] as number)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-5 py-3 text-[10px] text-white/35">
        <span>
          {isLive
            ? `Live forecast conditioned on ${lockedTotal} played match${lockedTotal === 1 ? "" : "es"} · only unplayed fixtures are simulated.`
            : `Pre-tournament forecast · ${data.simulations.toLocaleString()} simulations.`}
        </span>
        <span className="font-medium text-white/50">
          {asOf ? `Updated as of ${asOf}` : "No matches played yet"}
          {" · recomputed "}
          {new Date(data.generated_at).toLocaleString()}
        </span>
      </div>
    </div>
  );
}
