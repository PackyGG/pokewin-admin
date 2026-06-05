"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type {
  HeatmapData,
  HeatmapMetric,
} from "@/lib/queries/insights-analytics/heatmap";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const METRICS: { value: HeatmapMetric; label: string; rgb: string; isMoney: boolean }[] = [
  // Signup / active are blue (neutral activity), wager + P&L emerald
  // (house-positive), withdrawals rose (house-negative). Deposits use
  // emerald too — money flowing in.
  { value: "signups", label: "Signups", rgb: "59 130 246", isMoney: false },
  { value: "deposits", label: "Deposits", rgb: "16 185 129", isMoney: false },
  { value: "withdrawals", label: "Withdrawals", rgb: "244 63 94", isMoney: false },
  { value: "wager", label: "Wager", rgb: "16 185 129", isMoney: true },
  { value: "pnl", label: "P&L", rgb: "16 185 129", isMoney: true },
  { value: "active", label: "Active users", rgb: "6 182 212", isMoney: false },
];

/**
 * 7×24 heatmap with metric toggle. The data shape carries all 6 metric
 * arrays, so toggling between them is a pure client-side re-render
 * with no extra DB hit. URL stays in sync via ?heatmapMetric=…
 *
 * P&L uses absolute-max normalisation so negative cells (creator wins,
 * payout-dominant hours) still show meaningful intensity — they're
 * tinted rose, positive cells emerald.
 */
export function InsightsHeatmapGrid({
  data,
  initialMetric,
}: {
  data: HeatmapData;
  initialMetric: HeatmapMetric;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get("heatmapMetric");
  const metric =
    METRICS.some((m) => m.value === fromUrl) ? (fromUrl as HeatmapMetric) : initialMetric;
  const cfg = METRICS.find((m) => m.value === metric) ?? METRICS[0];
  const maxValue = data.maxes[metric];

  function hrefFor(m: HeatmapMetric): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("heatmapMetric", m);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-md border bg-muted/40 p-0.5 self-start">
          {METRICS.map((m) => (
            <Link
              key={m.value}
              href={hrefFor(m.value)}
              replace
              prefetch={false}
              className={cn(
                "rounded-sm px-2 py-0.5 text-xs font-medium transition-colors",
                metric === m.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </Link>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">Times in UTC. Darker = more.</div>
      </div>

      {/* Mobile-only hint that the 7×24 grid scrolls horizontally; the
          grid itself stays scrollable at every breakpoint (the min-width
          forces overflow at <md), but at md+ the viewport almost always
          fits the full 720px so the hint would be noise — hide it. */}
      <p className="text-[10px] text-muted-foreground md:hidden flex items-center gap-1">
        <span aria-hidden>↔</span>
        <span>Scroll horizontally to see the full week.</span>
      </p>
      <div className="relative">
        <div className="overflow-x-auto overscroll-x-contain">
          <div className="inline-block min-w-[720px]">
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

            {Array.from({ length: 7 }, (_, dow) => (
              <div key={dow} className="flex">
                <div className="flex h-7 w-10 shrink-0 items-center justify-end pr-2 text-[11px] text-muted-foreground">
                  {DAY_LABELS[dow]}
                </div>
                {Array.from({ length: 24 }, (_, hour) => {
                  const cell = data.cells[dow * 24 + hour];
                  if (!cell) return null;
                  const v = cell[metric];
                  const norm = maxValue > 0 ? Math.abs(v) / maxValue : 0;
                  const opacity = v !== 0 ? Math.max(0.05, Math.min(1, norm)) : 0;
                  // P&L cell goes rose when negative, emerald when positive
                  const rgb = metric === "pnl" && v < 0 ? "244 63 94" : cfg.rgb;
                  const tooltip = buildTooltip(dow, hour, cell, metric);
                  return (
                    <div
                      key={hour}
                      className={cn(
                        "mx-0.5 my-0.5 h-6 w-6 rounded-sm transition-colors",
                        v === 0 ? "bg-muted/30" : "",
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
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <span>Less</span>
          {[0.1, 0.3, 0.5, 0.7, 0.9].map((o, i) => (
            <span
              key={i}
              className="h-3 w-4 rounded-sm"
              style={{ backgroundColor: `rgb(${cfg.rgb} / ${o})` }}
            />
          ))}
          <span>More</span>
        </div>
        <span className="sm:ml-auto">
          Total:{" "}
          <span className="tabular-nums text-foreground">
            {cfg.isMoney
              ? formatCurrency(data.totals[metric])
              : formatNumber(data.totals[metric])}
          </span>
        </span>
      </div>
    </div>
  );
}

function buildTooltip(
  dow: number,
  hour: number,
  cell: HeatmapData["cells"][number],
  metric: HeatmapMetric,
): string {
  const head = `${DAY_LABELS[dow]} ${hour.toString().padStart(2, "0")}:00 UTC`;
  const lines: string[] = [head];
  if (metric === "wager" || metric === "pnl") {
    lines.push(`${formatCurrency(cell.wager)} wager`);
    lines.push(`${formatCurrency(cell.pnl)} P&L`);
  } else if (metric === "signups") {
    lines.push(`${formatNumber(cell.signups)} signups`);
  } else if (metric === "deposits") {
    lines.push(`${formatNumber(cell.deposits)} deposits`);
  } else if (metric === "withdrawals") {
    lines.push(`${formatNumber(cell.withdrawals)} withdrawals`);
  } else if (metric === "active") {
    lines.push(`${formatNumber(cell.active)} active users`);
  }
  return lines.join("\n");
}
