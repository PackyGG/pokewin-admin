"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { formatRelative } from "@/lib/utils/format";

/**
 * Subtle "Loaded in N ms · updated …" chip shown in the dashboard hero's
 * action slot.
 *
 * `queryMs` is the REAL server-side compute time for getDashboardStats
 * (measured in the query as Date.now() − t0, not faked). `generatedAt` is
 * the ISO timestamp the stats were produced at; the relative label is
 * recomputed on a 30s tick so "updated 2 minutes ago" stays honest between
 * the page's 60s server refreshes — without that tick the label would
 * freeze at "less than a minute ago" until the next router.refresh().
 *
 * Both props are plain serializable primitives, so this stays safe to hand
 * down from the streamed Server Component that reads the cached stats.
 */
export function LoadTimeIndicator({
  queryMs,
  generatedAt,
}: {
  queryMs: number;
  generatedAt: string;
}) {
  const [relative, setRelative] = useState(() => formatRelative(generatedAt));

  useEffect(() => {
    // Re-sync immediately when a fresh generatedAt arrives (after a server
    // refresh) then keep it current on a light interval.
    setRelative(formatRelative(generatedAt));
    const id = setInterval(() => {
      setRelative(formatRelative(generatedAt));
    }, 30_000);
    return () => clearInterval(id);
  }, [generatedAt]);

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-tiny font-medium text-muted-foreground"
      title={`Server-side dashboard compute time · data generated ${relative}`}
    >
      <Timer className="size-3 shrink-0" aria-hidden />
      <span className="tabular-nums text-foreground">{queryMs} ms</span>
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      {/* `relative` is derived from a wall-clock diff (formatRelative), so
          the server-rendered string and the first client render can differ
          by a tick — a latent React #418 hydration mismatch. suppressHydration
          Warning lets the client reconcile the relative-time text without a
          warning; the 30s tick + per-generatedAt re-sync keep it honest. */}
      <span suppressHydrationWarning>updated {relative}</span>
    </span>
  );
}
