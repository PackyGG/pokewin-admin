"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Period chip row for /insights/rewards/race. Exposes the same six
 * grain options the parent /insights/rewards page uses (24h / 3d / 7d /
 * 30d / 90d / lifetime) so admins can hop between the parent page and
 * the race deep-dive without losing their selected period.
 *
 * Preserves the other URL params (mainly `tab`) when switching periods.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

export function RaceInsightsPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";

  function hrefFor(value: string): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("period", value);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={hrefFor(value)}
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
