"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { INSIGHTS_PERIODS, type InsightsPeriod } from "./types";

const LABEL_SHORT: Record<InsightsPeriod, string> = {
  "24h": "24h",
  "3d": "3d",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  lifetime: "Lifetime",
};

/**
 * Period chip strip — global selector at the top of /insights/analytics.
 * Pattern mirrors the legacy /analytics period filter (rounded chip group
 * inside a muted-bg pill) so the two pages look like cousins. Persists
 * the active chip in `?period=` and preserves every other query param
 * (tab, sub-filters) on click.
 */
export function PeriodSelector() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("period") ?? "30d") as InsightsPeriod;

  function hrefFor(p: InsightsPeriod): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", p);
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
