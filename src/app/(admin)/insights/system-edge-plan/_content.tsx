import { SlidersHorizontal } from "lucide-react";

import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import { getSystemEdgeBaseline } from "./_baseline";
import { SystemEdgePlanner } from "./_planner";

/**
 * Server content for the System Edge Plan — fetches the REAL baseline for the
 * selected window (read-only) and hands the serialized primitives down to the
 * `"use client"` planner island. Lives inside the page's keyed `<Suspense>` so
 * only the active window is fetched (active-timeframe-only).
 *
 * If there is no real wager in the window the model has no gaming anchor to
 * stand on — we render a clean empty state rather than a projection built on
 * zeros (no fabricated baseline; the page is "always real data").
 */
export async function SystemEdgePlanContent({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const baseline = await getSystemEdgeBaseline(period);

  // The projection's GGR side needs real wager to anchor on. With zero wager
  // (no gameplay in the window) every projected figure would be 0 — not useful.
  if (baseline.wager <= 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
          <SlidersHorizontal className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">
          No gameplay to anchor on for this period
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The plan anchors on real production wager, edge and reward cost (
          {insightsRewardsPeriodLabel(period)}). There was no wager in this window,
          so there is nothing to project. Pick a wider period above.
        </p>
      </div>
    );
  }

  return <SystemEdgePlanner baseline={baseline} />;
}
