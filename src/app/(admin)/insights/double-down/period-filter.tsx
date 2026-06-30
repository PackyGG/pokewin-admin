"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  DOUBLE_DOWN_PERIODS,
  DEFAULT_DOUBLE_DOWN_PERIOD,
  type DoubleDownPeriod,
} from "@/lib/queries/double-down-shared";

const LABEL_SHORT: Record<DoubleDownPeriod, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "Lifetime",
};

/**
 * Period chip strip for /insights/double-down. Same muted-pill look + same
 * `?period=` persistence as the other insights pages. Switching the period
 * also resets the log to page 1 (and keeps the active username search) so a
 * shorter window never lands on a now-out-of-range page.
 *
 * Active-Timeframe-Only: changing the chip only changes the URL — the server
 * re-renders and loads ONLY the newly-active window.
 */
export function DoubleDownPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("period") ??
    DEFAULT_DOUBLE_DOWN_PERIOD) as DoubleDownPeriod;

  function hrefFor(p: DoubleDownPeriod): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", p);
    params.delete("page"); // reset pagination on window change
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {DOUBLE_DOWN_PERIODS.map((p) => (
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
