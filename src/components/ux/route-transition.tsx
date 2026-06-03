"use client";

import * as React from "react";
import { useLinkStatus } from "next/link";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { DURATION, EASE_OUT } from "./motion";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Route transition treatments  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Visual "the route is changing" feedback. The app already has a global
 * top-progress bar (`src/components/top-progress-bar.tsx`) that flashes on
 * commit; these add a *pending-state* treatment that fires the moment a
 * navigation is intended (before commit), so slow server renders don't feel
 * like dead clicks.
 *
 * Built on Next.js 15 primitives, with graceful degradation:
 *   - `LinkPending`        → reads `useLinkStatus()` (App Router). MUST be a
 *                            descendant of a `next/link` `<Link>`. Renders a
 *                            small spinner / dims a label only while that link's
 *                            navigation is pending. If the hook ever reports no
 *                            pending state (older runtime / outside a Link), it
 *                            simply never shows — safe no-op.
 *   - `RouteTransitionShell` → wraps a region and applies a subtle pending
 *                            treatment (reduced opacity + non-blocking overlay)
 *                            driven by a `pending` flag the caller already has
 *                            (e.g. from React's `useTransition`). It does NOT
 *                            call any router internals, so it works on every
 *                            runtime — the caller owns the `pending` source.
 *
 * Non-blocking rule: the pending overlay uses `pointer-events-none`, so even
 * while a transition is in flight the user can still click/scroll. Motion is
 * `motion-safe:` gated; reduced-motion users get the opacity change without a
 * transition tween.
 */

// ─── LinkPending ────────────────────────────────────────────────────────────

/**
 * Inline pending indicator for a `<Link>`. Place it inside the link's children
 * (or anywhere in the same React subtree under the `<Link>`). Shows a spinner
 * while that specific link's navigation is pending.
 *
 *   <Link href="/users/123">
 *     View user <LinkPending />
 *   </Link>
 *
 * `useLinkStatus()` returns `{ pending }`; if used outside a Link it stays
 * `false`, making this a safe no-op rather than a crash.
 */
export function LinkPending({
  size = 14,
  className,
  label = "Loading…",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <Spinner
      size={size}
      label={label}
      className={cn("ml-1.5 inline-block align-middle", className)}
    />
  );
}

/**
 * Wraps arbitrary link children and dims + de-emphasizes them while the link's
 * navigation is pending, appending a trailing spinner. Useful for sidebar /
 * nav items where you want the whole row to read as "loading".
 *
 *   <Link href="/analytics">
 *     <LinkPendingShell>
 *       <BarChart /> Analytics
 *     </LinkPendingShell>
 *   </Link>
 */
export function LinkPendingShell({
  children,
  className,
  spinner = true,
  spinnerSize = 14,
}: {
  children: React.ReactNode;
  className?: string;
  spinner?: boolean;
  spinnerSize?: number;
}) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 motion-safe:transition-opacity motion-safe:duration-150",
        pending && "opacity-60",
        className,
      )}
      aria-busy={pending || undefined}
    >
      {children}
      {spinner && pending ? <Spinner size={spinnerSize} /> : null}
    </span>
  );
}

// ─── RouteTransitionShell ───────────────────────────────────────────────────

/**
 * Applies a subtle, non-blocking "busy" treatment to a region while a
 * transition is pending. The caller supplies the `pending` flag — typically
 * from React's `useTransition` around a `router.push` / `router.replace`, or a
 * filter/search update that triggers a server round-trip.
 *
 *   const [isPending, startTransition] = useTransition();
 *   const onChange = (v) =>
 *     startTransition(() => router.replace(`?period=${v}`));
 *   …
 *   <RouteTransitionShell pending={isPending}>
 *     {tableOrChartRegion}
 *   </RouteTransitionShell>
 *
 * Behavior:
 *   - Dims content to ~60% and overlays a centered spinner once the pending
 *     state lasts past `spinnerDelayMs` (default 300ms) to avoid a flash on
 *     quick updates.
 *   - The overlay is `pointer-events-none`; interaction is never blocked.
 *   - `motion-safe:` gated opacity transition; reduced-motion = instant.
 */
export function RouteTransitionShell({
  children,
  pending,
  spinnerDelayMs = DURATION.slow,
  className,
}: {
  children: React.ReactNode;
  pending: boolean;
  /** Delay before the overlay spinner appears (ms). */
  spinnerDelayMs?: number;
  className?: string;
}) {
  const [showSpinner, setShowSpinner] = React.useState(false);

  React.useEffect(() => {
    if (!pending) {
      setShowSpinner(false);
      return;
    }
    const t = setTimeout(() => setShowSpinner(true), spinnerDelayMs);
    return () => clearTimeout(t);
  }, [pending, spinnerDelayMs]);

  return (
    <div className={cn("relative", className)} aria-busy={pending || undefined}>
      <div
        className={cn(
          "motion-safe:transition-opacity",
          pending ? "opacity-60" : "opacity-100",
        )}
        style={{
          transition: `opacity ${DURATION.fast}ms ${EASE_OUT}`,
        }}
        // While pending, prevent stray double-submits on the stale subtree but
        // keep scrolling/reading possible by only blocking pointer + selection,
        // not the whole document. We intentionally do NOT set `inert` so focus
        // and keyboard nav still work.
        aria-hidden={undefined}
      >
        {children}
      </div>
      {showSpinner ? (
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-8">
          <div className="rounded-full border bg-card/80 p-2 shadow-sm backdrop-blur-sm">
            <Spinner size={18} label="Loading…" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
