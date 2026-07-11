import { Trophy, Globe } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { CountryUserCount } from "@/lib/queries/map";
import { flagEmoji, METRIC_META, metricValue, type MapMetric } from "./utils";

/**
 * Top-10 country ranking for the currently-selected metric.
 *
 * Server-rendered — we derive the list from the same data the map
 * consumes, sort by the selected metric, and render a flag + name +
 * progress bar + value row. The progress bar width encodes the share
 * of the #1 value, which makes the tail of the list easier to read
 * at a glance than raw numbers alone.
 */
export function CountryLeaderboard({
  data,
  metric,
}: {
  data: CountryUserCount[];
  metric: MapMetric;
}) {
  const sorted = [...data]
    .map((entry) => ({ entry, value: metricValue(entry, metric) }))
    .filter(({ value }) => value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const max = sorted[0]?.value ?? 0;
  const meta = METRIC_META[metric];

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
      <div className="relative">
        <SectionHeading icon={Trophy} title={`Top markets · ${meta.label}`} />

        {sorted.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No data for this metric"
            description="No countries have activity for the selected metric yet."
            compact
          />
        ) : (
          <ol className="mt-4 space-y-2.5">
            {sorted.map(({ entry, value }, i) => {
              const share = max > 0 ? value / max : 0;
              const label =
                entry.country ?? entry.country_code.toUpperCase() ?? "—";
              return (
                <li
                  key={entry.country_code}
                  className="group rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-muted/30"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-5 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="text-lg leading-none" aria-hidden>
                      {flagEmoji(entry.country_code) || "🏳️"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {label}
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-foreground">
                          {formatMetric(value, metric)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full motion-safe:transition-all motion-safe:duration-500"
                          style={{
                            width: `${(share * 100).toFixed(1)}%`,
                            background:
                              "linear-gradient(to right, color-mix(in oklch, var(--primary) 55%, transparent), var(--primary))",
                          }}
                        />
                      </div>
                      {metric !== "users" && entry.user_count > 0 ? (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {formatNumber(entry.user_count)} user
                          {entry.user_count === 1 ? "" : "s"}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
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
