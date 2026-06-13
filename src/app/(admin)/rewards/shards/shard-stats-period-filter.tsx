"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { LinkPending } from "@/components/ux";

/**
 * Window selector for the shard/coin economy stats section. Mirrors the
 * /rewards/analytics RewardsPeriodFilter (chip row, replace navigation,
 * no prefetch) with the windows this surface supports: 24h / 7d / 30d /
 * all. Replace-navigation keeps the URL the single source of truth so
 * the server fetches ONLY the active window (active-timeframe-only) — no
 * eager preload of the other windows.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All", value: "all" },
] as const;

export function ShardStatsPeriodFilter() {
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
          scroll={false}
          className={cn(
            "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
          <LinkPending size={13} />
        </Link>
      ))}
    </div>
  );
}
