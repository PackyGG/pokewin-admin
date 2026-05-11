"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

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
 *   • Dashboard: 60s — KPIs don't shift meaningfully in <1 min, and
 *     the live feeds (recent activity SSE, live pulls WS) stream
 *     independently so the user keeps real-time visibility.
 *   • Analytics: 300s (5 min) — reporting view; cohorts/funnel/LTV
 *     numbers don't change second-to-second.
 *   • Anywhere else: default 60s.
 *
 * The visibility guard stays: when the tab is backgrounded we skip
 * the refresh entirely so a forgotten tab doesn't burn cycles.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [router, intervalMs]);

  return null;
}
