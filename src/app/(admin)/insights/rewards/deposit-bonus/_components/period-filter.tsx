"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Period selector for /insights/rewards/deposit-bonus. Same window set
 * as the parent /insights/rewards page so the experience reconciles
 * when an admin drills in from the rewards overview.
 *
 * Preserves `?tab=` so flipping the period doesn't bounce the admin
 * back to the Overview tab.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function DepositBonusPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";
  const tab = searchParams.get("tab");
  const carryTab = tab ? `&tab=${encodeURIComponent(tab)}` : "";

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={`${pathname}?period=${value}${carryTab}`}
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
