"use client";

import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Globe2 } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { CountryUserCount } from "@/lib/queries/map";
import {
  CONTINENT_COLORS,
  CONTINENT_ORDER,
  continentFor,
  METRIC_META,
  metricValue,
  type Continent,
  type MapMetric,
} from "./utils";

/**
 * Continent-level aggregation of the per-country rows. The pie chart
 * slices encode the share each continent holds of the currently
 * selected metric. Rendered client-side so the metric swap animates
 * smoothly via recharts.
 */
export function ContinentBreakdown({
  data,
  metric,
}: {
  data: CountryUserCount[];
  metric: MapMetric;
}) {
  const slices = useMemo(() => {
    const totals = new Map<Continent, number>();
    for (const entry of data) {
      const v = metricValue(entry, metric);
      if (v <= 0) continue;
      const continent = continentFor(entry.country_code);
      totals.set(continent, (totals.get(continent) ?? 0) + v);
    }
    const rows = CONTINENT_ORDER.filter((c) => (totals.get(c) ?? 0) > 0).map(
      (c) => ({
        name: c,
        value: totals.get(c) ?? 0,
        color: CONTINENT_COLORS[c],
      }),
    );
    const total = rows.reduce((s, r) => s + r.value, 0);
    return { rows, total };
  }, [data, metric]);

  const meta = METRIC_META[metric];

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
      <div className="relative">
        <SectionHeading icon={Globe2} title={`By continent · ${meta.label}`} />

        {slices.rows.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No data for this metric.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-[180px_1fr] md:items-center">
            {/* Pie height bumped a touch on phones so the donut doesn't
                feel cramped above the legend list. */}
            <div className="h-[200px] w-full md:h-[180px]">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={slices.rows}
                    dataKey="value"
                    innerRadius={48}
                    outerRadius={78}
                    paddingAngle={2}
                    stroke="none"
                    isAnimationActive
                    animationDuration={700}
                    animationEasing="ease-out"
                  >
                    {slices.rows.map((row) => (
                      <Cell key={row.name} fill={row.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    cursor={false}
                    content={(props) => {
                      const raw = props.payload;
                      const mapped = raw?.map((p) => ({
                        name: p.name,
                        value: typeof p.value === "number" ? p.value : Number(p.value ?? 0),
                        payload: p.payload as { color?: string } | undefined,
                      }));
                      return (
                        <PieTooltip
                          payload={mapped}
                          metric={metric}
                          total={slices.total}
                        />
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <ul className="space-y-1.5">
              {slices.rows.map((row) => {
                const share = slices.total > 0 ? row.value / slices.total : 0;
                return (
                  <li
                    key={row.name}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block size-2.5 rounded-sm"
                        style={{ background: row.color }}
                        aria-hidden
                      />
                      <span className="truncate text-foreground/90">
                        {row.name}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="tabular-nums font-medium">
                        {formatMetric(row.value, metric)}
                      </span>
                      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                        {(share * 100).toFixed(1)}%
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function formatMetric(value: number, metric: MapMetric): string {
  const meta = METRIC_META[metric];
  switch (meta.format) {
    case "currency":
      return formatCurrency(value);
    case "multiplier":
      return `${value.toFixed(2)}×`;
    case "number":
    default:
      return formatNumber(value);
  }
}

type PiePayloadEntry = {
  name?: string | number;
  value?: number;
  payload?: { color?: string };
};

function PieTooltip({
  payload,
  metric,
  total,
}: {
  payload?: PiePayloadEntry[];
  metric: MapMetric;
  total: number;
}) {
  if (!payload?.length) return null;
  const entry = payload[0];
  const value = entry.value ?? 0;
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <span
          className="inline-block size-2.5 rounded-sm"
          style={{ background: entry.payload?.color ?? "currentColor" }}
          aria-hidden
        />
        <span>{String(entry.name ?? "")}</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
        <span>{METRIC_META[metric].label}</span>
        <span className="text-right font-semibold tabular-nums text-foreground">
          {formatMetric(value, metric)}
        </span>
        <span>Share</span>
        <span className="text-right tabular-nums text-foreground">
          {share.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}
