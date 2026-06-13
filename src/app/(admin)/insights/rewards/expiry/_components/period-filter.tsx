"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Period selector for /insights/rewards/expiry.
 *
 * Same six-window grain (24h / 3d / 7d / 30d / 90d / lifetime) and
 * navigation pattern (replace + no prefetch) as the sibling rakeback
 * insights pages so the two filters look and behave identically.
 *
 * The window drives the "forfeited-by-lapsing" cohort (prior-equal vs
 * current window). The expiry CONFIG panel is window-independent — it
 * always shows the live claim windows.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function ExpiryPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={`${pathname}?period=${value}`}
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
