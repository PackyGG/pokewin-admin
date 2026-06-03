"use client";

import * as React from "react";
import { Suspense } from "react";
import { cn } from "@/lib/utils";
import { DelayedSpinnerFallback } from "./spinner";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  LazyModalContent  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Defers mounting a heavy overlay body until the overlay is actually `open`,
 * and keeps it cheap to re-open by not rendering its expensive subtree while
 * closed. Pairs with the existing base-ui `Dialog` / `Sheet` primitives — drop
 * it INSIDE `<DialogContent>` (or a `<Sheet>` body) around the costly part.
 *
 * Two layers of laziness:
 *   1. Gate on `open` — children are not rendered (and their effects/queries
 *      don't run) until the overlay opens. This is the perf win the
 *      "Active-Timeframe-Only / don't load hidden components" rule asks for:
 *      modal bodies must not do heavy work before they're shown.
 *   2. A `<Suspense>` boundary with a delay-gated spinner, so a body that
 *      itself suspends (e.g. a `React.lazy()` form or an async child) shows a
 *      spinner only after ~300ms instead of flashing one.
 *
 * Reduced-motion + a11y are inherited from the spinner fallback.
 *
 * Note on Next.js boundaries: `React.lazy()` for client-only heavy widgets
 * works here because this is a Client Component. For server data, keep using
 * async Server Components fed into the overlay from the page — this wrapper
 * does not replace that; it governs *when* the client subtree mounts.
 */
export function LazyModalContent({
  open,
  children,
  fallback,
  minHeight = 160,
  keepMounted = false,
  className,
}: {
  /** Whether the parent overlay is currently open. */
  open: boolean;
  children: React.ReactNode;
  /** Custom pending UI; defaults to a delay-gated centered spinner. */
  fallback?: React.ReactNode;
  /** Reserve height so the body doesn't jump when content resolves. */
  minHeight?: number | string;
  /**
   * Keep children mounted after the first open (preserve form state between
   * close/reopen). Default `false` — fully unmount on close to free resources.
   */
  keepMounted?: boolean;
  className?: string;
}) {
  // Track whether we've ever been opened, so `keepMounted` can retain the
  // subtree across subsequent closes without rendering it before first open.
  const openedOnce = React.useRef(false);
  if (open) openedOnce.current = true;

  const shouldRender = open || (keepMounted && openedOnce.current);

  return (
    <div
      className={cn(className)}
      style={{ minHeight }}
      // When kept mounted but hidden, take it out of the a11y tree + layout.
      hidden={keepMounted && !open ? true : undefined}
    >
      {shouldRender ? (
        <Suspense
          fallback={fallback ?? <DelayedSpinnerFallback className="min-h-32" />}
        >
          {children}
        </Suspense>
      ) : null}
    </div>
  );
}
