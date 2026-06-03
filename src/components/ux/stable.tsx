import * as React from "react";
import { Suspense } from "react";
import { cn } from "@/lib/utils";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Layout-stability wrappers  (pokewin-admin · src/components/ux)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Dimension-stable containers that reserve space so swapping skeleton → real
 * content (or empty → populated) never shifts the page. Cumulative Layout
 * Shift (CLS) is the #1 cause of "the page jumped while I was reading it" in a
 * dense admin panel; these wrappers pin a min-height (and optionally an exact
 * height) on the region.
 *
 * Server-safe: no client hooks, no browser APIs. Import from anywhere.
 */

// ─── StableCard ─────────────────────────────────────────────────────────────

/**
 * Card-chrome wrapper with a reserved `minHeight` so its height doesn't snap
 * when content finishes loading. Matches the app's standard card surface
 * (rounded-xl border, bg-card) by default; pass `bare` to drop the chrome and
 * only keep the height reservation.
 *
 *   <StableCard minHeight={180}>
 *     <Suspense fallback={<SkeletonText lines={4} />}>{slot}</Suspense>
 *   </StableCard>
 */
export function StableCard({
  children,
  minHeight,
  height,
  bare = false,
  padded = true,
  className,
}: {
  children: React.ReactNode;
  /** Reserved minimum height (px or CSS length). Prevents collapse + grow. */
  minHeight?: number | string;
  /** Exact fixed height (px or CSS length). Use when the slot is known-size. */
  height?: number | string;
  /** Drop the card border/background — just the stable box. */
  bare?: boolean;
  /** Apply standard card padding (p-4 sm:p-5). */
  padded?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        !bare && "rounded-xl border bg-card",
        !bare && padded && "p-4 sm:p-5",
        className,
      )}
      style={{ minHeight, height }}
    >
      {children}
    </div>
  );
}

// ─── StableTable ────────────────────────────────────────────────────────────

/**
 * Reserves the vertical space a data table will occupy, computed from the
 * expected row count and row height plus header/toolbar/pagination chrome.
 * Holds the scroll position steady while the table streams in.
 *
 * The math mirrors `SkeletonTable`'s defaults: header (~49px) + rows × height,
 * with optional toolbar (~52px) and pagination (~52px) bands added on.
 */
export function StableTable({
  children,
  rows = 8,
  rowHeight = 52,
  withToolbar = false,
  withPagination = false,
  className,
}: {
  children: React.ReactNode;
  /** Expected visible rows — drives the reserved height. */
  rows?: number;
  /** Per-row height in px (match the real table). */
  rowHeight?: number;
  /** Reserve space for a toolbar above the table. */
  withToolbar?: boolean;
  /** Reserve space for a pagination bar below the table. */
  withPagination?: boolean;
  className?: string;
}) {
  const HEADER = 49;
  const BAND = 52;
  const minHeight =
    HEADER +
    rows * rowHeight +
    (withToolbar ? BAND : 0) +
    (withPagination ? BAND : 0);
  return (
    <div className={className} style={{ minHeight }}>
      {children}
    </div>
  );
}

// ─── StableBlock ────────────────────────────────────────────────────────────

/**
 * Bare-minimum height reservation for any region (charts, lists, custom
 * panels) where you just need to pin space and don't want card chrome.
 */
export function StableBlock({
  children,
  minHeight,
  height,
  className,
}: {
  children: React.ReactNode;
  minHeight?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <div className={className} style={{ minHeight, height }}>
      {children}
    </div>
  );
}

// ─── PageReadyBoundary ──────────────────────────────────────────────────────

/**
 * Convenience Suspense boundary: wraps async children with a skeleton fallback
 * and (optionally) a reserved min-height so the fallback → content swap is
 * shift-free. This is the one-liner most pages/sections should reach for
 * instead of hand-writing `<Suspense fallback=…>` + a stability wrapper.
 *
 *   <PageReadyBoundary fallback={<SkeletonTable rows={10} />} minHeight={560}>
 *     <UsersTable …/>   {/* async server component *​/}
 *   </PageReadyBoundary>
 *
 * Pass a stable `boundaryKey` (e.g. `${tab}-${period}`) to force a fresh
 * fallback when the *inputs* change — the lazy-tab / period-swap pattern the
 * Insights pages already use. Without a key, React keeps showing stale content
 * while the next payload streams (often desirable; opt into the reset only when
 * the content identity actually changes).
 */
export function PageReadyBoundary({
  children,
  fallback,
  minHeight,
  boundaryKey,
  className,
}: {
  children: React.ReactNode;
  fallback: React.ReactNode;
  /** Reserve space so the fallback and the eventual content match in height. */
  minHeight?: number | string;
  /** Change this to reset the boundary (re-show the fallback) on input change. */
  boundaryKey?: string;
  className?: string;
}) {
  const body = (
    <Suspense key={boundaryKey} fallback={fallback}>
      {children}
    </Suspense>
  );
  if (minHeight == null && !className) return body;
  return (
    <div className={className} style={{ minHeight }}>
      {body}
    </div>
  );
}
