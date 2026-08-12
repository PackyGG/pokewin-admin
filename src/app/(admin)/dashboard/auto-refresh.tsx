"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * A refresh that is still resolving is skipped rather than stacked — but only
 * for this long. `router.refresh()`'s transition settling is not something this
 * component can guarantee (a discarded navigation, a frozen tab), and a
 * transition that never settles would otherwise silence the page permanently.
 */
const MAX_INFLIGHT_MS = 5 * 60_000;

/**
 * Periodic `router.refresh()` for pages that need server-side numbers
 * to stay reasonably fresh without an explicit reload.
 *
 * Cadence was 15s site-wide which hammered the main game DB: every
 * mounted dashboard tab triggered ~28 queries/cycle (incl. the giant
 * 36-column period-aggregates CTE) and every analytics tab triggered
 * 11+ heavy CTEs (PERCENTILE_CONT, multi-level cohorts, …). At 4
 * concurrent admins that was ~17k queries/hour from polling alone.
 *
 * `intervalMs` is now a per-page knob:
 *   • Dashboard: 60s — refreshes the KPI and chart data.
 *   • Analytics: 300s (5 min) — reporting view; cohorts/funnel/LTV
 *     numbers don't change second-to-second.
 *   • Anywhere else: default 60s.
 *
 * The visibility guard stays: when the tab is backgrounded we skip
 * the refresh entirely so a forgotten tab doesn't burn cycles.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPending) startedAtRef.current = null;
  }, [isPending]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // Each refresh re-runs the page's whole server fan-out against a MAIN
      // mirror pool of two connections. Firing the next tick while the previous
      // render is still queued behind that pool does not produce fresher
      // numbers — it just adds a second full fan-out to the queue the first one
      // is already waiting in.
      const startedAt = startedAtRef.current;
      if (startedAt !== null && Date.now() - startedAt < MAX_INFLIGHT_MS) return;
      startedAtRef.current = Date.now();
      startTransition(() => {
        router.refresh();
      });
    }, intervalMs);
    return () => clearInterval(interval);
  }, [router, intervalMs, startTransition]);

  return null;
}
