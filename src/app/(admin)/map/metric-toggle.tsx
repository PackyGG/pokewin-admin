"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Users, TrendingUp, Swords, Percent } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAP_METRICS, METRIC_META, parseMetric, type MapMetric } from "./utils";

const METRIC_ICON: Record<MapMetric, React.ElementType> = {
  users: Users,
  deposits: TrendingUp,
  wagers: Swords,
  multiplier: Percent,
};

/**
 * Pill-group metric selector for the map visualization. Mirrors the
 * pattern used by the existing PeriodFilter so the two filters look
 * the same on the page. Preserves the `period` query param across
 * navigations so swapping a metric never loses the current time range.
 */
export function MetricToggle() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = parseMetric(searchParams.get("metric") ?? undefined);

  function hrefFor(metric: MapMetric): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("metric", metric);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
      {MAP_METRICS.map((metric) => {
        const Icon = METRIC_ICON[metric];
        const active = current === metric;
        return (
          <Link
            key={metric}
            href={hrefFor(metric)}
            replace
            prefetch={false}
            scroll={false}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{METRIC_META[metric].short}</span>
          </Link>
        );
      })}
    </div>
  );
}
