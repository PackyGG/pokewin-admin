"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Live "time remaining" for a leaderboard row.
 *
 * Leaderboards run for days/weeks, so this ticks at a coarse cadence (every
 * 30s) rather than per-second — enough to keep "2d 4h" honest without a
 * needless 1Hz timer. Renders compact "Nd Nh" / "Nh Nm" / "Nm" and a terminal
 * label once the edge passes.
 *
 * `initialMs` is computed ONCE on the server (`edge − Date.now()` at request
 * time) and serialized down, so the first client paint is byte-identical to the
 * SSR markup (no hydration mismatch — same approach as the dashboard
 * RainCountdown). The post-mount effect re-syncs to the live clock and starts
 * the tick. Props are plain serializable primitives — no function props cross
 * the server→client boundary.
 */
function formatRemaining(ms: number, ended: boolean): string {
  if (ms <= 0) return ended ? "ended" : "starting…";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function LeaderboardTimeLeft({
  edgeIso,
  initialMs,
  /** When true the edge is the END date (so a passed edge reads "ended"). */
  ended = true,
  className,
}: {
  edgeIso: string;
  initialMs: number;
  ended?: boolean;
  className?: string;
}) {
  const target = new Date(edgeIso).getTime();
  const [remaining, setRemaining] = useState(initialMs);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    setRemaining(target - Date.now());
    const id = setInterval(() => setRemaining(target - Date.now()), 30_000);
    return () => clearInterval(id);
  }, [target]);

  return (
    <span className={cn("tabular-nums", className)}>
      {formatRemaining(remaining, ended)}
    </span>
  );
}
