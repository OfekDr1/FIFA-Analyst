"use client";

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";

// UK home-nation flags use subdivision codes flagcdn supports directly.
const SUBDIVISION: Record<string, string> = {
  "🏴󠁧󠁢󠁥󠁮󠁧󠁿": "gb-eng",
  "🏴󠁧󠁢󠁳󠁣󠁴󠁿": "gb-sct",
  "🏴󠁧󠁢󠁷󠁬󠁳󠁿": "gb-wls",
};

// An emoji flag is literally two regional-indicator letters → decode to ISO-3166 alpha-2.
function emojiToISO2(emoji?: string): string | null {
  if (!emoji) return null;
  const letters = [...emoji]
    .map((c) => c.codePointAt(0) ?? 0)
    .filter((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff)
    .map((cp) => String.fromCharCode(cp - 0x1f1e6 + 65));
  return letters.length === 2 ? letters.join("").toLowerCase() : null;
}

/**
 * Build a priority list of flag image URLs. flagcdn.com (high-res, reliable,
 * no key) is preferred so a real national flag always renders; the API crest
 * is a secondary source. Exported so backgrounds/watermarks can reuse it.
 */
export function flagSources(
  flag?: string,
  crest?: string,
  code?: string
): string[] {
  const out: string[] = [];
  const sub = flag ? SUBDIVISION[flag] : undefined;
  const iso =
    sub ??
    emojiToISO2(flag) ??
    (code && code.length === 2 ? code.toLowerCase() : null);
  if (iso) out.push(`https://flagcdn.com/w320/${iso}.png`);
  if (crest) out.push(crest);
  return out;
}

interface CrestProps {
  crest?: string;
  flag?: string;
  code?: string;
  name: string;
  size?: number;
  className?: string;
  glow?: boolean;
  square?: boolean;
}

/**
 * Circular (or rounded-square) team flag. Falls through a source chain and,
 * only if every image fails, shows a Globe icon — never raw text codes.
 */
export function Crest({
  crest,
  flag,
  code,
  name,
  size = 40,
  className = "",
  glow = false,
  square = false,
}: CrestProps) {
  const sources = flagSources(flag, crest, code);
  const [idx, setIdx] = useState(0);

  // Reset to the preferred source whenever the team changes.
  const primary = sources[0] ?? "";
  useEffect(() => setIdx(0), [primary]);

  const src = sources[idx];
  const shape = square ? "rounded-xl" : "rounded-full";

  return (
    <span
      className={`relative inline-flex items-center justify-center ${shape} overflow-hidden bg-white/10 ring-1 ring-white/15 shrink-0 transition-all duration-300 ${
        glow ? "shadow-[0_0_20px_-3px_rgba(255,255,255,0.35)]" : ""
      } ${className}`}
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setIdx((i) => i + 1)}
          className="w-full h-full object-cover"
        />
      ) : (
        <Globe
          className="text-slate-500"
          style={{ width: size * 0.5, height: size * 0.5 }}
        />
      )}
    </span>
  );
}
