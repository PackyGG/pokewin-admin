"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  INSIGHTS_PERIODS,
  DEFAULT_INSIGHTS_PERIOD,
  type InsightsPeriod,
} from "@/lib/queries/insights-analytics/period";

const LABEL_SHORT: Record<InsightsPeriod, string> = {
  "24h": "24h",
  "3d": "3d",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  // Display label stays "Lifetime" (cousin to /insights/analytics) — the
  // underlying URL token is the canonical "all".
  all: "Lifetime",
};

/**
 * Period chip strip for /insights/cost-breakdown. Mirrors the
 * /insights/analytics PeriodSelector exactly (same chip set, same muted
 * pill, same `?period=` persistence) so the two pages read as cousins.
 *
 * Client-safe: imports only the client-safe period constants/type from
 * analytics/types (no server query value imports), so this never drags
 * a server-only graph into the browser bundle.
 */
export function CostBreakdownPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("cbPeriod") ??
    DEFAULT_INSIGHTS_PERIOD) as InsightsPeriod;

  function hrefFor(p: InsightsPeriod): string {
    const params = new URLSearchParams(searchParams.toString());
    // `cbPeriod`, not `period`: /analytics owns `period` with a different
    // vocabulary. `tab` is pinned so a period click stays on this tab.
    params.set("cbPeriod", p);
    params.set("tab", "cost-breakdown");
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {INSIGHTS_PERIODS.map((p) => (
        <Link
          key={p}
          href={hrefFor(p)}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm",
            current === p
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LABEL_SHORT[p]}
        </Link>
      ))}
    </div>
  );
}
