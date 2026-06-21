"use client";

import { useEffect, useRef, useState } from "react";

export interface LiveTeam {
  id: string;
  name: string;
  tla?: string;
  crest?: string;
}

export interface LiveMatch {
  id: string;
  status: string;
  minute: number | null;
  stage: string;
  group: string | null;
  home: LiveTeam;
  away: LiveTeam;
  score: { home: number; away: number };
}

export interface GoalEvent {
  matchId: string;
  team: "home" | "away";
  teamName: string;
  crest?: string;
  tla?: string;
  key: number;
}

const POLL_MS = 30_000; // 30s → 2 req/min, well under the 10/min free limit
const GOAL_DURATION = 5_000;
const MUTE_KEY = "goalSoundMuted";

/**
 * Encapsulates live-match polling, goal detection, sound, and the mute
 * preference. The returned `goal` drives the global celebration overlay,
 * while `matches` feeds the in-page tracker — keeping the two concerns
 * fully decoupled.
 */
export function useLiveMatches(demo = false) {
  const [matches, setMatches] = useState<LiveMatch[]>([]);
  const [ready, setReady] = useState(false);
  const [goal, setGoal] = useState<GoalEvent | null>(null);
  const [muted, setMuted] = useState(false);

  const prevScores = useRef<Map<string, { home: number; away: number }>>(new Map());
  const goalCounter = useRef(0);
  const goalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Audio element + persisted mute preference (client only)
  useEffect(() => {
    try {
      const v = localStorage.getItem(MUTE_KEY);
      if (v != null) setMuted(v === "1");
    } catch {
      /* ignore */
    }
    const audio = new Audio("/goal.mp3");
    audio.volume = 0.7;
    audio.preload = "auto";
    audioRef.current = audio;
    return () => {
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      try {
        localStorage.setItem(MUTE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useEffect(() => {
    let active = true;
    const endpoint = demo ? "/api/live?demo=1" : "/api/live";

    const fireGoal = (m: LiveMatch, team: "home" | "away") => {
      goalCounter.current += 1;
      const t = team === "home" ? m.home : m.away;
      setGoal({
        matchId: m.id,
        team,
        teamName: t.name,
        crest: t.crest,
        tla: t.tla,
        key: goalCounter.current,
      });

      if (!mutedRef.current && audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(() => {
          /* autoplay may be blocked until first user gesture */
        });
      }

      if (goalTimer.current) clearTimeout(goalTimer.current);
      goalTimer.current = setTimeout(() => {
        if (active) setGoal(null);
      }, GOAL_DURATION);
    };

    const poll = async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!active) return;

        const incoming: LiveMatch[] = data.matches ?? [];

        for (const m of incoming) {
          const prev = prevScores.current.get(m.id);
          if (prev) {
            if (m.score.home > prev.home) fireGoal(m, "home");
            else if (m.score.away > prev.away) fireGoal(m, "away");
          }
          prevScores.current.set(m.id, { home: m.score.home, away: m.score.away });
        }
        const ids = new Set(incoming.map((m) => m.id));
        for (const id of [...prevScores.current.keys()]) {
          if (!ids.has(id)) prevScores.current.delete(id);
        }

        setMatches(incoming);
        setReady(true);
      } catch {
        if (active) setReady(true);
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      active = false;
      clearInterval(interval);
      if (goalTimer.current) clearTimeout(goalTimer.current);
    };
  }, [demo]);

  return { matches, ready, goal, muted, toggleMute };
}
