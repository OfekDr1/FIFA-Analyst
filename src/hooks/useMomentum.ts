"use client";

import { useEffect, useState } from "react";
import { loadMomentumScores } from "@/lib/predictions";

/**
 * Loads the momentum scores once on mount and returns a `ready` flag.
 * Add the flag to a prediction's useMemo deps so it recomputes with
 * momentum applied as soon as the data is available.
 */
export function useMomentum(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    loadMomentumScores().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return ready;
}
