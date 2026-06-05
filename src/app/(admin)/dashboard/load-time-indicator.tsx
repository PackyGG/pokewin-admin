"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Format a server-measured fetch duration for the per-box readout:
 *   • < 1000 ms → "142 ms"   (integer milliseconds)
 *   • ≥ 1000 ms → "1.3 s"    (one-decimal seconds)
 * Negative / NaN inputs are clamped to 0 so a clock glitch never prints
 * "-3 ms" or "NaN ms".
 */
export function formatBoxLoadMs(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 1000) return `${Math.round(safe)} ms`;
  return `${(safe / 1000).toFixed(1)} s`;
}

/**
 * Height of the bottom-right corner strip the timing badge occupies,
 * exported so every box can reserve EXACTLY this much clear space at the
 * bottom of its content (via {@link BOX_TIMING_RESERVE}) — the badge then
 * sits in empty space and never overlaps the box's last content row.
 *
 * The badge is `text-[10px]` (≈14px line box) pinned at `bottom-1.5`
 * (6px), so ~20px of clear space below the content keeps it fully clear at
 * every breakpoint. Kept as a single source of truth so the badge's size
 * and the reserved gutter can never drift apart.
 */
export const BOX_TIMING_RESERVE = "pb-5";

/**
 * Tiny per-box load-time readout pinned to the BOTTOM-RIGHT corner of a
 * dashboard data box. Shows how long THAT box's data took to fetch
 * (measured server-side, passed down as a plain number), formatted by
 * {@link formatBoxLoadMs} ("142 ms" / "1.3 s").
 *
 * Layout contract (must NOT change the box's size, must NOT clip content):
 *   • `absolute` + `pointer-events-none` so it overlays the box's corner
 *     and never participates in layout or steals clicks from controls
 *     underneath (popover triggers, chart bars).
 *   • The HOST element is responsible for `relative` positioning — use the
 *     {@link BoxTimingFrame} wrapper, which adds `relative` without altering
 *     the wrapped card's own box model.
 *   • The host's content reserves {@link BOX_TIMING_RESERVE} of clear space
 *     at the bottom so the badge sits BELOW the last content row instead of
 *     occluding it (the bug this replaced: the badge sat on top of the GGR
 *     hero number / the rightmost breakdown chip, making the box read as if
 *     its content "stopped 2cm short" of the edge). Reserving the strip lifts
 *     the whole content row uniformly — it never shrinks content horizontally.
 *   • Muted, `tabular-nums`, `text-[10px]` — unobtrusive, matches the
 *     dashboard's secondary-text treatment. No animation (nothing to
 *     reduce-motion-guard); inherits the app's static styling.
 *
 * `ms` is a serializable number prop — no function props cross the RSC
 * boundary (CLAUDE.md / Next 15).
 */
export function BoxLoadTime({
  ms,
  className,
}: {
  ms: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      title={`This box's data fetched server-side in ${formatBoxLoadMs(ms)}`}
      className={cn(
        "pointer-events-none absolute bottom-1.5 right-2 z-10 inline-flex items-center gap-1 rounded text-[10px] font-medium leading-none tabular-nums text-muted-foreground/55",
        className,
      )}
    >
      <Timer className="size-2.5 shrink-0" aria-hidden />
      {formatBoxLoadMs(ms)}
    </span>
  );
}

/**
 * Wrapper that makes any dashboard box a positioning context for its
 * corner {@link BoxLoadTime} readout WITHOUT changing the box's own
 * dimensions. Renders a `relative` div around the box and drops the
 * timing badge into its bottom-right corner.
 *
 * The wrapper div is `display: contents`-like in spirit but uses a plain
 * relative block so the absolute badge has a containing block; it adds no
 * padding, border, or background, so the wrapped `<Card>` renders exactly
 * as before — only now with a muted "N ms" in the corner. Pass the same
 * grid-cell classes you'd put on the card via `className` if the wrapper
 * needs to stretch (e.g. `h-full` in the 50/50 row).
 *
 * Clear-space contract: the wrapped card is responsible for reserving
 * {@link BOX_TIMING_RESERVE} of bottom padding on its content row so the
 * badge sits in empty space and never occludes the last line. The KPI /
 * today cards do this on their `CardContent`; charts naturally have an
 * empty band under their x-axis, so they need nothing extra.
 *
 * `badgeClassName` is forwarded to the inner {@link BoxLoadTime} if a box
 * needs to nudge the badge (rare). It is NO LONGER used for a backdrop —
 * reserved clear space (above) replaces the old `bg-card/…` blur chip that
 * sat on top of content.
 *
 * `ms` is a plain number (serializable across the RSC boundary).
 */
export function BoxTimingFrame({
  ms,
  className,
  badgeClassName,
  children,
}: {
  ms: number;
  className?: string;
  badgeClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("relative", className)}>
      {children}
      <BoxLoadTime ms={ms} className={badgeClassName} />
    </div>
  );
}

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
