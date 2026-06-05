"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { DURATION, EASE_OUT, prefersReducedMotion } from "./motion";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  TabContainer — keep-mounted tab panels with a smooth crossfade + height
 *  pokewin-admin · src/components/ux
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A reusable body for tabbed surfaces (user / creator / insights detail pages).
 * It owns ONLY the panel-swap presentation; the tab *triggers* and the
 * active-tab state stay with the caller (so the caller can drive them from URL
 * params via `PeriodChips`/`TabChips`, local state, etc.). You pass the active
 * tab id and the panels; this component:
 *
 *   1. KEEPS PANELS MOUNTED. Every panel stays in the tree; inactive ones are
 *      `hidden` (display:none → no layout cost, no tab-stops) rather than
 *      unmounted. Switching back to a tab is instant — no re-fetch, no remount
 *      flash, scroll position within a panel is preserved.
 *
 *   2. CROSSFADES on switch — OPACITY ONLY. The active panel fades from 0→1.
 *      No transforms (so nothing shifts horizontally), matching the app's
 *      restrained motion language. Reduced-motion users get an instant swap.
 *
 *   3. ANIMATES HEIGHT. The wrapper measures the active panel and tweens its
 *      own height between the old and new panel heights (~220ms, the `base`
 *      duration token) so going from a tall tab to a short one does not SNAP
 *      the page shorter. Once settled it releases back to `height:auto` so the
 *      panel can still grow/shrink naturally (async content, window resize).
 *
 *   4. OPTIONAL keyed Suspense. Pass `suspense` (and optional `fallback`) to
 *      wrap each panel in `<React.Suspense key={tabId}>`. The `key` makes the
 *      boundary re-suspend per tab, so a lazily-loaded panel shows its own
 *      fallback on first reveal instead of one shared boundary — the standard
 *      lazy-tab pattern. Combine with the caller only *fetching* the active
 *      tab's data to honour the active-timeframe-only rule.
 *
 * Serializable-by-caller: panels are `React.ReactNode`, so this is composed in
 * a Client island (it carries "use client"); render the heavy panel content as
 * children from a Server Component above if you want it server-rendered.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   const [tab, setTab] = React.useState("overview");
 *   <TabChips items={tabs} current={tab} paramKey="tab" />   // triggers (URL)
 *   <TabContainer
 *     activeId={tab}
 *     panels={[
 *       { id: "overview", content: <OverviewPanel /> },
 *       { id: "activity", content: <ActivityPanel /> },
 *       { id: "ledger",   content: <LedgerPanel /> },
 *     ]}
 *     suspense
 *     fallback={<SkeletonTable rows={6} />}
 *   />
 */

export type TabPanel = {
  /** Stable id; must match the caller's active-tab value. */
  id: string;
  /** Panel body. */
  content: React.ReactNode;
};

export function TabContainer({
  activeId,
  panels,
  className,
  panelClassName,
  suspense = false,
  fallback = null,
  /** Height tween duration in ms (default = DURATION.base, ~220ms). */
  heightDurationMs = DURATION.base,
}: {
  activeId: string;
  panels: readonly TabPanel[];
  className?: string;
  panelClassName?: string;
  suspense?: boolean;
  fallback?: React.ReactNode;
  heightDurationMs?: number;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  // Maps panel id → its mounted node, so we can measure the active panel's
  // natural height before/after a switch.
  const panelNodes = React.useRef<Map<string, HTMLDivElement | null>>(
    new Map(),
  );
  // The animated wrapper height. `null` = released to `height:auto` (the
  // resting state, so content can reflow freely).
  const [wrapperHeight, setWrapperHeight] = React.useState<number | null>(null);
  const prevActiveRef = React.useRef(activeId);

  // Animate the wrapper height across a tab switch: pin to the OLD panel's
  // height for one frame, then transition to the NEW panel's height, then
  // release to auto. Layout effect so we capture the outgoing height before
  // paint. Honours reduced-motion (instant, no pin).
  React.useLayoutEffect(() => {
    if (prevActiveRef.current === activeId) return;
    const prevId = prevActiveRef.current;
    prevActiveRef.current = activeId;

    const nextNode = panelNodes.current.get(activeId);
    const prevNode = panelNodes.current.get(prevId);
    if (!nextNode) return;

    if (prefersReducedMotion()) {
      // No tween: stay on height:auto so the swap is instant.
      setWrapperHeight(null);
      return;
    }

    const fromH = prevNode?.offsetHeight ?? nextNode.offsetHeight;
    const toH = nextNode.offsetHeight;

    // Pin to the outgoing height first…
    setWrapperHeight(fromH);
    // …then on the next frame tween to the incoming height.
    const raf = requestAnimationFrame(() => {
      setWrapperHeight(toH);
    });

    // Release to `auto` after the tween so later content reflow isn't capped.
    const release = setTimeout(() => {
      setWrapperHeight(null);
    }, heightDurationMs + 30);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(release);
    };
  }, [activeId, heightDurationMs]);

  return (
    <div
      ref={wrapperRef}
      className={cn("relative motion-safe:overflow-hidden", className)}
      style={
        wrapperHeight !== null
          ? {
              height: wrapperHeight,
              transition: `height ${heightDurationMs}ms ${EASE_OUT}`,
            }
          : undefined
      }
    >
      {panels.map(({ id, content }) => {
        const active = id === activeId;
        const body = suspense ? (
          // Keyed so the boundary re-suspends per tab (lazy-tab pattern):
          // a freshly-revealed lazy panel shows its own fallback instead of a
          // single shared one.
          <React.Suspense key={id} fallback={fallback}>
            {content}
          </React.Suspense>
        ) : (
          content
        );
        return (
          <div
            key={id}
            ref={(node) => {
              panelNodes.current.set(id, node);
            }}
            role="tabpanel"
            hidden={!active}
            aria-hidden={!active}
            className={cn(
              // Opacity-only crossfade on the active panel — no transform, so
              // nothing shifts sideways. motion-safe gated → instant for
              // reduced-motion. Inactive panels are display:none (hidden attr)
              // so they cost no layout and trap no focus.
              active &&
                "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
              panelClassName,
            )}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
