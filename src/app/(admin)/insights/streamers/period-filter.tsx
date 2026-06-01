"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "Lifetime", value: "lifetime" },
] as const;

/**
 * Period chip strip for the streamer insights page. Mirrors
 * /analytics/period-filter so the UX is consistent, but extends to 24h
 * and 3d windows because abuse-signal detection cares about short bursts
 * the analytics page doesn't surface. Default = 7d to match what the
 * `parsePeriod` helper falls back to so the chips and the data agree on
 * mount.
 */
export function PeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "7d";

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
