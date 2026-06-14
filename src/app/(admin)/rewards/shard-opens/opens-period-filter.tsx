"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { LinkPending } from "@/components/ux";

/**
 * Window selector for the shard-pack opens surface. Mirrors the
 * /rewards/shards economy ShardStatsPeriodFilter (chip row, replace
 * navigation, no prefetch) with the windows this surface supports:
 * 24h / 7d / 30d / all. Replace-navigation keeps the URL the single
 * source of truth so the server fetches ONLY the active window
 * (active-timeframe-only) — no eager preload of the other windows.
 *
 * Switching the window also resets pagination to page 1: the windowed
 * result set is different, so the previous offset would land mid-data.
 */
const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All", value: "all" },
] as const;

export function OpensPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";

  // Preserve perPage across a window switch; drop page (reset to 1).
  function hrefFor(value: string): string {
    const params = new URLSearchParams();
    params.set("period", value);
    const perPage = searchParams.get("perPage");
    if (perPage) params.set("perPage", perPage);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={hrefFor(value)}
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
