"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Period selector for /insights/rewards. The page exposes a wider set
 * of windows than /rewards/analytics — admins explicitly asked for the
 * 24h / 3d / 7d / 30d / 90d / lifetime grain so they can sanity-check
 * shorter-term spikes against longer-term trends without leaving the
 * page.
 *
 * Same nav pattern as the rewards-analytics period filter (chip row,
 * replace navigation, no prefetch). Preserves `?tab=` so flipping the
 * period doesn't kick the admin back to the Overview tab.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function InsightsRewardsPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `rwPeriod` / `rw`: /analytics owns `period` and `tab`, so this tab
  // namespaces its own. `tab=rewards` is pinned so a click stays here.
  const current = searchParams.get("rwPeriod") ?? "30d";
  const sub = searchParams.get("rw");
  const carrySub = sub ? `&rw=${encodeURIComponent(sub)}` : "";

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={`${pathname}?tab=rewards&rwPeriod=${value}${carrySub}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
