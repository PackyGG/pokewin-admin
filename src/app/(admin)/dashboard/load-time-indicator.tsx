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
 * `initialRelative` is the relative string formatted ONCE on the server (in
 * the dashboard page) and serialized down. The first client paint renders
 * that exact string, so it is byte-identical to the SSR markup — no hydration
 * mismatch. Deriving the string from `Date.now()` during render instead (the
 * previous approach) made the server-formatted value and the first
 * client-formatted value disagree, which React surfaces as a recoverable
 * hydration error (minified #418) in production even with
 * `suppressHydrationWarning`. The post-mount effect re-derives from
 * `generatedAt` and keeps the 30s tick going.
 *
 * All props are plain serializable primitives, so this stays safe to hand
 * down from the streamed Server Component that reads the cached stats.
 */
export function LoadTimeIndicator({
  queryMs,
  generatedAt,
  initialRelative,
}: {
  queryMs: number;
  generatedAt: string;
  initialRelative: string;
}) {
  const [relative, setRelative] = useState(initialRelative);

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
      <span>updated {relative}</span>
    </span>
  );
}
