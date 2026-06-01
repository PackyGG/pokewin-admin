"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Period selector for /insights/rewards/signup. Mirrors the parent
 * /insights/rewards page's filter — 24h / 3d / 7d / 30d / 90d / lifetime.
 *
 * Preserves `?tab=` across switches so flipping the period doesn't kick
 * the admin back to the Overview tab. `replace` + `prefetch={false}`
 * matches the existing parent filter so behaviour is consistent across
 * the insights surface.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function SignupInsightsPeriodFilter() {
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
