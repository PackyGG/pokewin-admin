import { Suspense } from "react";
import { parseXpSalesPeriod } from "@/lib/queries/insights-xp-sales";
import { XpSalesSection } from "../xp-sales/xp-sales-section";

/**
 * XP Sales tab of the merged /rewards page (was the standalone /xp-sales page).
 *
 * Every `xp_purchase` ledger row is a user spending their own withdrawable USD
 * balance to buy XP. Rolls those up over the active window: KPI strip, daily
 * revenue trend, recent-sales list. House-POV (buying XP gives up a dollar we
 * owed → house gain → emerald). Customer-scoped, drift-guarded.
 *
 * Active-timeframe-only: only the active window is fetched; switching the
 * period (`?period=`) streams just that window via the period-keyed Suspense.
 * `?period=` does not collide with the top-level `?tab=`.
 */
export function XpSalesTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const period = parseXpSalesPeriod(params.period);

  return (
    <Suspense
      key={period}
      fallback={
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-[88px] animate-pulse rounded-xl border bg-muted/30"
              />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-2xl border bg-muted/30" />
          <div className="h-64 animate-pulse rounded-2xl border bg-muted/30" />
        </div>
      }
    >
      <XpSalesSection period={period} />
    </Suspense>
  );
}
