"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  PageTransition — subtle route-enter animation for the shell content slot
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Wraps the routed content area in each app shell so a *new page* eases in
 * (soft fade + a 1px upward slide) instead of snapping. This is the "page
 * switches feel smooth" companion to the global TopProgressBar (which flashes
 * the load cue) and the per-link pending spinners — the bar says "loading",
 * this says "here's the new page".
 *
 * ── Why it keys on PATHNAME ONLY (never searchParams) ─────────────────────
 *   The animation is re-triggered by giving the inner wrapper a React `key`
 *   equal to `usePathname()`. A changed key remounts the wrapper, which
 *   re-runs the CSS enter animation. We deliberately key on the pathname
 *   alone so that IN-PAGE param updates — the dashboard `?period=`, the
 *   insights `?tab=`, any filter/search that only edits the query string —
 *   do NOT change the key and therefore do NOT re-animate (or remount) the
 *   whole page. Only real navigations (a different route) animate. This
 *   mirrors `ScrollToTopOnNav`, which keys on pathname for the same reason.
 *
 * ── Why it's Suspense-stream-safe ─────────────────────────────────────────
 *   • It wraps the OUTER content (`children`) with plain CSS classes + a key.
 *     Any `<Suspense>` boundaries live INSIDE `children`; their fallbacks
 *     still stream in exactly as before — this wrapper never sits between a
 *     boundary and its fallback, so it can't suppress streaming.
 *   • It adds no data fetching and no effects. Remounting on a genuine route
 *     change is what Next already does with the new route's subtree; this
 *     just attaches an entrance animation to it. It does NOT cause extra
 *     server round-trips beyond the normal navigation.
 *   • The enter animation is opacity + a 1px transform only (GPU-composited,
 *     via tw-animate-css `animate-in fade-in slide-in-from-bottom-1`). It
 *     reserves no space and shifts no layout, so there is zero CLS.
 *
 * ── Reduced motion ────────────────────────────────────────────────────────
 *   The animation is `motion-safe:`-gated (only `motion-safe:animate-in` is
 *   applied; the `fade-in`/`slide-in-from-bottom-1`/`duration-150` utilities
 *   are inert without it). Users with `prefers-reduced-motion: reduce` land on
 *   the final page state instantly with no fade and no slide — we never
 *   animate behind their back.
 *
 * ── Layout / docked-rail safety ───────────────────────────────────────────
 *   The wrapper is a bare `<div>` with no positioning, sizing, overflow, or
 *   background of its own — it is display:block and simply passes the content
 *   through. It is mounted INSIDE the shell's existing scroll container, well
 *   below the topbar/breadcrumbs, and does not touch the docked right rail
 *   (which is a sibling of the scroll container, not a child of this wrapper).
 *   So the topbar, breadcrumbs, and docked rail never animate or shift; only
 *   the page body eases in.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div
      key={pathname}
      className="motion-safe:animate-in fade-in slide-in-from-bottom-1 duration-150"
    >
      {children}
    </div>
  );
}
