import Link from "next/link";
import { Users } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getInsightsCohorts,
  parseCohortsGranularity,
  type CohortBucket,
  type CohortData,
  type CohortsGranularity,
} from "@/lib/queries/insights-analytics/cohorts";
import { EmptyState } from "@/components/empty-state";
import type { InsightsPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Cohorts tab — signup cohorts (week / month) with 4 lenses:
 *   1. Retention %  — distinct retained / cohort size
 *   2. Wager        — total customer wager in period
 *   3. GGR          — house gain in period (House-POV emerald)
 *   4. Deposits     — total deposits in period
 *
 * Period filter is informational only — cohorts are inherently lifetime
 * relative to signup date; the granularity (week / month) is the
 * meaningful control.
 */
export async function CohortsInsightsTab({
  period: _period,
  granularity,
}: {
  period: InsightsPeriod;
  granularity: string | undefined;
}) {
  void _period;
  const gran = parseCohortsGranularity(granularity);
  const { data, error } = await safeQuery(
    () => getInsightsCohorts(gran),
    null,
    "insights-analytics.cohorts",
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics — Cohorts"
        hint="The cohorts query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return (
    <FadeIn>
      <div className="space-y-4">
        <Intro granularity={gran} />
        <GranularityToggle current={gran} />
        {data.buckets.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No cohorts yet"
            description="Once enough users sign up we'll group them here by week or month."
          />
        ) : (
          <div className="space-y-4">
            <CohortGrid
              data={data}
              metric="retained"
              title="Retention %"
              description="Distinct users in cohort that placed a wager in period N"
              hueRgb="59 130 246"
              normalize="pct"
            />
            <CohortGrid
              data={data}
              metric="wager"
              title="Wager volume"
              description="Customer wager in period N (no on-stream creator play)"
              hueRgb="16 185 129"
              normalize="max"
            />
            <CohortGrid
              data={data}
              metric="ggr"
              title="GGR"
              description="House gain in period N — wagers − payouts"
              hueRgb="16 185 129"
              normalize="max"
            />
            <CohortGrid
              data={data}
              metric="deposits"
              title="Deposits"
              description="Total deposits per period N"
              hueRgb="16 185 129"
              normalize="max"
            />
          </div>
        )}
      </div>
    </FadeIn>
  );
}

function Intro({ granularity }: { granularity: CohortsGranularity }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
      <div className="rounded-md bg-primary/10 p-1.5">
        <Users className="size-4 text-primary" />
      </div>
      <div className="text-sm">
        <h3 className="font-semibold">Signup cohorts</h3>
        <p className="text-muted-foreground">
          Users are grouped by their signup {granularity}. Each column shows
          activity N {granularity}s after signup. Four lenses: how many came
          back, how much they wagered, how much we made, and how much they
          deposited. Darker = higher.
        </p>
      </div>
    </div>
  );
}

function GranularityToggle({ current }: { current: CohortsGranularity }) {
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-1 self-start w-fit">
      {(["week", "month"] as const).map((g) => (
        <Link
          key={g}
          href={`?tab=cohorts&cohortsBy=${g}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
            current === g
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {g === "week" ? "Week" : "Month"}
        </Link>
      ))}
    </div>
  );
}

function CohortGrid({
  data,
  metric,
  title,
  description,
  hueRgb,
  normalize,
}: {
  data: CohortData;
  metric: "retained" | "wager" | "ggr" | "deposits";
  title: string;
  description: string;
  hueRgb: string;
  normalize: "pct" | "max";
}) {
  // Compute the cell intensity. `pct` mode uses (retained / size); `max`
  // mode normalizes against the period's maximum so the visual range
  // adapts to the metric's scale.
  const valueAt = (b: CohortBucket, idx: number): number => {
    if (metric === "retained") return b.retained[idx];
    if (metric === "wager") return b.wager[idx];
    if (metric === "ggr") return b.ggr[idx];
    return b.deposits[idx];
  };

  const maxValue = (() => {
    let m = 0;
    for (const b of data.buckets) {
      for (let i = 0; i < data.maxPeriods; i++) {
        const v = valueAt(b, i);
        if (v > m) m = v;
      }
    }
    return m;
  })();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto overscroll-x-contain">
          <div className="inline-block min-w-[680px]">
            {/* Header row — period labels */}
            <div className="flex">
              <div className="w-28 shrink-0 text-[11px] font-medium text-muted-foreground">
                Cohort
              </div>
              <div className="w-16 shrink-0 text-right text-[11px] font-medium text-muted-foreground">
                Size
              </div>
              {Array.from({ length: data.maxPeriods }, (_, i) => (
                <div
                  key={i}
                  className="w-16 shrink-0 text-center text-[10px] font-medium text-muted-foreground tabular-nums"
                >
                  {data.granularity === "week" ? `W${i}` : `M${i}`}
                  {i === data.maxPeriods - 1 && "+"}
                </div>
              ))}
            </div>
            {data.buckets.map((b) => (
              <div key={b.cohort} className="flex items-center">
                <div className="w-28 shrink-0 truncate text-xs font-medium text-foreground">
                  {b.label}
                </div>
                <div className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {formatNumber(b.size)}
                </div>
                {Array.from({ length: data.maxPeriods }, (_, i) => {
                  const v = valueAt(b, i);
                  const pct = normalize === "pct" ? (b.size > 0 ? v / b.size : 0) : maxValue > 0 ? v / maxValue : 0;
                  const opacity = v > 0 ? Math.max(0.06, Math.min(1, pct)) : 0;
                  const display = metric === "retained" ? `${Math.round((b.size > 0 ? v / b.size : 0) * 100)}%` : formatCurrency(v);
                  return (
                    <div
                      key={i}
                      className={cn(
                        "mx-0.5 my-0.5 flex h-7 w-16 items-center justify-center rounded-sm text-[10px] tabular-nums",
                        v === 0 ? "bg-muted/30 text-muted-foreground" : "text-foreground",
                      )}
                      style={{
                        backgroundColor:
                          opacity > 0 ? `rgb(${hueRgb} / ${opacity})` : undefined,
                      }}
                      title={`${b.label} · ${data.granularity === "week" ? "Week" : "Month"} ${i}\n${display}\n${formatNumber(b.retained[i])} retained · ${formatCurrency(b.wager[i])} wager`}
                    >
                      {v > 0 ? display : ""}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
