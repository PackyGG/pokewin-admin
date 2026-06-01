"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { RAKEBACK_ROI_LOOKBACK_OPTIONS } from "../_constants";

/**
 * Lookback selector for the ROI tab. Lookback drives how many forward
 * days of gameplay GGR are credited to each claimant when computing
 * subsequentGgr / cost. Defaults to 14d; admins can dial it down to
 * 3d (e.g. for very short campaigns) or up to 60d (long-tail recoup).
 *
 * Preserves `?period=`, `?tab=`, `?scope=` so flipping lookback doesn't
 * lose the rest of the page state.
 */
export function RakebackRoiLookbackFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("lookback") ?? "14";
  const period = searchParams.get("period");
  const tab = searchParams.get("tab") ?? "roi";
  const scope = searchParams.get("scope");
  const carry = [
    period ? `period=${encodeURIComponent(period)}` : null,
    tab ? `tab=${encodeURIComponent(tab)}` : null,
    scope ? `scope=${encodeURIComponent(scope)}` : null,
  ]
    .filter(Boolean)
    .join("&");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        Lookback
      </span>
      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
        {RAKEBACK_ROI_LOOKBACK_OPTIONS.map((opt) => {
          const active = current === String(opt);
          const params = [`lookback=${opt}`, carry].filter(Boolean).join("&");
          return (
            <Link
              key={opt}
              href={`${pathname}?${params}`}
              replace
              prefetch={false}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt}d
            </Link>
          );
        })}
      </div>
    </div>
  );
}
