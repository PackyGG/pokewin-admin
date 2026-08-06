"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

import { cn } from "@/lib/utils";

export type LeaderboardCountdownMode =
  | "starts_in"
  | "ends_in"
  | "ended"
  | "cancelled";

function formatRemaining(ms: number, mode: LeaderboardCountdownMode): string {
  if (mode === "cancelled") return "Cancelled";
  if (mode === "ended" || ms <= 0) {
    return mode === "starts_in" ? "Started" : "Ended";
  }

  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  // Under an hour — show minutes + seconds so "almost done" is obvious.
  if (totalSec < 3600) {
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Under an hour `formatRemaining` shows seconds, so the clock must tick 1Hz. */
const FAST_TICK_BELOW_MS = 3600_000;
const FAST_TICK_MS = 1000;
const SLOW_TICK_MS = 30_000;

/**
 * Live countdown for a single affiliate leaderboard on the admin detail page.
 * `initialMs` is computed on the server so the first paint matches SSR.
 */
export function LeaderboardDetailCountdown({
  mode,
  edgeIso,
  initialMs,
  className,
}: {
  mode: LeaderboardCountdownMode;
  edgeIso: string;
  initialMs: number;
  className?: string;
}) {
  const target = new Date(edgeIso).getTime();
  const [remaining, setRemaining] = useState(initialMs);

  // Which cadence bucket we're in — a BOOLEAN, deliberately, so the effect
  // re-runs exactly once (when the board crosses the hour) instead of on every
  // tick. The interval used to be computed once at mount, so a board opened
  // with >1h left kept ticking every 30s after dropping under the hour, while
  // `formatRemaining` had already switched to `Xm SSs` — the seconds field
  // jumped by 30 and read as broken.
  const fastTick = remaining < FAST_TICK_BELOW_MS;

  useEffect(() => {
    if (mode !== "starts_in" && mode !== "ends_in") return;
    if (!Number.isFinite(target)) return;

    const sync = () => setRemaining(target - Date.now());
    sync();
    const id = setInterval(sync, fastTick ? FAST_TICK_MS : SLOW_TICK_MS);
    return () => clearInterval(id);
  }, [mode, target, fastTick]);

  const label =
    mode === "starts_in"
      ? "Starts in"
      : mode === "ends_in"
        ? "Ends in"
        : mode === "cancelled"
          ? "Status"
          : "Status";

  const tone =
    mode === "ends_in" && remaining > 0 && remaining < 3600_000
      ? "text-amber-600 dark:text-amber-400"
      : mode === "ended"
        ? "text-muted-foreground"
        : mode === "ends_in" || mode === "starts_in"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground";

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-3 py-2.5",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock className="size-4 shrink-0" aria-hidden />
        <span>{label}</span>
      </div>
      <span className={cn("text-base font-semibold tabular-nums", tone)}>
        {formatRemaining(remaining, mode)}
      </span>
    </div>
  );
}
