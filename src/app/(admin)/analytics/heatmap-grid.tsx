"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { HeatmapData } from "@/lib/queries/analytics-heatmap";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * 7×24 heatmap. Each cell's color intensity = metric value / period max,
 * clamped to [0.05, 1]. "Wager" mode uses blue (neutral money activity);
 * "deposits" mode uses emerald (house inflows). Metric toggle persists
 * in URL as `?heatmapMetric=…`.
 */
export function HeatmapGrid({ data }: { data: HeatmapData }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const metric: "wager" | "deposits" =
    searchParams.get("heatmapMetric") === "deposits" ? "deposits" : "wager";

  const maxValue = metric === "wager" ? data.maxWager : data.maxDeposits;
  const rgb = metric === "wager" ? "59 130 246" : "16 185 129";

  function hrefFor(m: "wager" | "deposits"): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("heatmapMetric", m);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-md border bg-muted/40 p-0.5 self-start">
          {(["wager", "deposits"] as const).map((m) => (
            <Link
              key={m}
              href={hrefFor(m)}
              replace
              prefetch={false}
              className={cn(
                "rounded-sm px-2 py-0.5 text-xs font-medium transition-colors",
                metric === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "wager" ? "Wager Volume" : "Deposit Count"}
            </Link>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">
          Times in UTC. Darker = more activity.
        </div>
      </div>

      {/* Heatmap grid is 7×24 cells × 28px each ≈ 720px wide. Phones
          can't fit it, so wrap in a horizontal scroller with an explicit
          min-w so cell sizes stay readable when the user pans. */}
      <div className="overflow-x-auto">
        <div className="inline-block min-w-[720px]">
          {/* Header row: hour labels */}
          <div className="flex">
            <div className="w-10 shrink-0" />
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="h-5 w-7 text-center text-[10px] text-muted-foreground tabular-nums"
              >
                {h % 3 === 0 ? h.toString().padStart(2, "0") : ""}
              </div>
            ))}
          </div>

          {/* 7 rows × 24 columns */}
          {Array.from({ length: 7 }, (_, dow) => (
            <div key={dow} className="flex">
              <div className="flex h-7 w-10 shrink-0 items-center justify-end pr-2 text-[11px] text-muted-foreground">
                {DAY_LABELS[dow]}
              </div>
              {Array.from({ length: 24 }, (_, hour) => {
                const cell = data.cells[dow * 24 + hour];
                if (!cell) return null;
                const value = metric === "wager" ? cell.wager : cell.deposits;
                const intensity = maxValue > 0 ? value / maxValue : 0;
                const opacity = value > 0 ? Math.max(0.05, Math.min(1, intensity)) : 0;
                const tooltip = `${DAY_LABELS[dow]} ${hour.toString().padStart(2, "0")}:00 UTC\n${formatCurrency(cell.wager)} wagered · ${formatNumber(cell.deposits)} deposits`;
                return (
                  <div
                    key={hour}
                    className={cn(
                      "mx-0.5 my-0.5 h-6 w-6 rounded-sm transition-colors",
                      value === 0 ? "bg-muted/30" : "",
                    )}
                    style={{
                      backgroundColor:
                        opacity > 0 ? `rgb(${rgb} / ${opacity})` : undefined,
                    }}
                    title={tooltip}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Intensity legend — gradient ramp on the left, total on the
          right. Wraps to two rows on a 360px viewport so the total
          isn't pushed off-screen by the swatches. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <span>Less</span>
          {[0.1, 0.3, 0.5, 0.7, 0.9].map((o, i) => (
            <span
              key={i}
              className="h-3 w-4 rounded-sm"
              style={{ backgroundColor: `rgb(${rgb} / ${o})` }}
            />
          ))}
          <span>More</span>
        </div>
        <span className="sm:ml-auto">
          Total:{" "}
          <span className="tabular-nums text-foreground">
            {metric === "wager"
              ? formatCurrency(data.totalWager)
              : formatNumber(data.totalDeposits)}
          </span>
        </span>
      </div>
    </div>
  );
}
