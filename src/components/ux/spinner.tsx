"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPINNER_DELAY_MS } from "./motion";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Spinner + delayed fallbacks  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A plain spinner plus delay-gated wrappers so fast resolutions never flash a
 * loading indicator. The classic UX rule: show nothing for the first ~300ms,
 * then a spinner if we're still waiting. Sub-300ms transitions feel instant
 * and a flashed-then-gone spinner reads as jank.
 *
 * Reduced-motion: lucide's `Loader2` spins via Tailwind `animate-spin`. We gate
 * it behind `motion-safe:` so reduced-motion users see a static glyph (still a
 * clear "busy" cue) with no rotation.
 */

// ─── Spinner ────────────────────────────────────────────────────────────────

export function Spinner({
  size = 16,
  className,
  label,
}: {
  size?: number;
  className?: string;
  /** Visually-hidden status text for assistive tech. */
  label?: string;
}) {
  return (
    <span role="status" aria-live="polite" className="inline-flex">
      {label ? <span className="sr-only">{label}</span> : null}
      <Loader2
        aria-hidden
        className={cn("motion-safe:animate-spin text-muted-foreground", className)}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

// ─── DelayedSpinnerFallback ─────────────────────────────────────────────────

/**
 * Renders nothing for `delayMs` (default 300ms), then a centered spinner.
 * Drop this in as a `<Suspense fallback>` for content you expect to resolve
 * quickly most of the time — the spinner only appears on genuinely slow loads.
 *
 * Because this mounts only while its Suspense boundary is pending, the timer
 * starts on mount and is torn down the instant the real content swaps in.
 */
export function DelayedSpinnerFallback({
  delayMs = SPINNER_DELAY_MS,
  className,
  size = 20,
  label = "Loading…",
}: {
  delayMs?: number;
  className?: string;
  size?: number;
  label?: string;
}) {
  const show = useDelayedFlag(delayMs);
  return (
    <div
      className={cn(
        "flex min-h-24 w-full items-center justify-center py-8",
        className,
      )}
    >
      {show ? <Spinner size={size} label={label} /> : null}
    </div>
  );
}

// ─── DeferredContent ────────────────────────────────────────────────────────

/**
 * Delays revealing its children until `delayMs` has elapsed, optionally showing
 * a placeholder in the meantime. Useful for content that is cheap to render but
 * should not pop in the same frame as a heavier sibling (avoids a janky
 * double-paint), or to hold back a spinner-bearing region.
 *
 * Unlike Suspense, this is purely time-based and client-side — it does not wait
 * on data. Use it to *debounce a visual reveal*, not to gate on a promise.
 *
 *   placeholder defaults to `null` (render nothing until ready).
 */
export function DeferredContent({
  children,
  delayMs = SPINNER_DELAY_MS,
  placeholder = null,
}: {
  children: React.ReactNode;
  delayMs?: number;
  placeholder?: React.ReactNode;
}) {
  const ready = useDelayedFlag(delayMs);
  return <>{ready ? children : placeholder}</>;
}

// ─── hook ───────────────────────────────────────────────────────────────────

/**
 * Returns `false` until `delayMs` has elapsed since mount, then `true`.
 * Shared by the delay-gated components above. Exported for callers that need
 * the same "don't flash" timing in bespoke UI.
 */
export function useDelayedFlag(delayMs = SPINNER_DELAY_MS): boolean {
  const [ready, setReady] = React.useState(delayMs <= 0);
  React.useEffect(() => {
    if (delayMs <= 0) {
      setReady(true);
      return;
    }
    const t = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
  return ready;
}
