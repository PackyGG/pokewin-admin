import Link from "next/link";
import { Percent, Users, TrendingDown } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricTile } from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import {
  getInsightsRetention,
  parseRetentionBreakdown,
  type RetentionBreakdownKey,
} from "@/lib/queries/insights-analytics/retention";
import { EmptyState } from "@/components/empty-state";
import { MultiRetentionChart } from "./multi-retention-chart";
import type { InsightsPeriod } from "./types";

/**
 * Retention tab — Day 1/7/30/90 retention with optional breakdown by
 * source (organic / creator-affiliate / regular-affiliate) or country
 * (top 5 + Other).
 *
 * Period filter is informational only — retention horizon is fixed at
 * 180 days by design.
 */
export async function RetentionInsightsTab({
  period: _period,
  breakdownBy,
}: {
  period: InsightsPeriod;
  breakdownBy: string | undefined;
}) {
  void _period;
  const bk = parseRetentionBreakdown(breakdownBy);
  const data = await getInsightsRetention(bk);

  // Aggregate KPI strip uses the "all" series if no breakdown, otherwise
  // the weighted-average of the breakdown series.
  const agg = aggregate(data.series);

  return (
    <FadeIn>
      <div className="space-y-4">
        <Intro breakdownBy={bk} />
        <BreakdownToggle current={bk} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="D1 Retention"
            value={`${(agg.d1 * 100).toFixed(1)}%`}
            sub={`${formatNumber(agg.cohort)} eligible users`}
            icon={agg.d1 >= 0.2 ? Users : TrendingDown}
            accent={agg.d1 >= 0.2 ? "emerald" : agg.d1 >= 0.05 ? "amber" : "rose"}
          />
          <MetricTile
            label="D7 Retention"
            value={`${(agg.d7 * 100).toFixed(1)}%`}
            sub={`${formatNumber(agg.cohort)} eligible users`}
            icon={agg.d7 >= 0.2 ? Users : TrendingDown}
            accent={agg.d7 >= 0.2 ? "emerald" : agg.d7 >= 0.05 ? "amber" : "rose"}
          />
          <MetricTile
            label="D30 Retention"
            value={`${(agg.d30 * 100).toFixed(1)}%`}
            sub={`${formatNumber(agg.cohort)} eligible users`}
            icon={agg.d30 >= 0.2 ? Users : TrendingDown}
            accent={agg.d30 >= 0.2 ? "emerald" : agg.d30 >= 0.05 ? "amber" : "rose"}
          />
          <MetricTile
            label="D90 Retention"
            value={`${(agg.d90 * 100).toFixed(1)}%`}
            sub={`${formatNumber(agg.cohort)} eligible users`}
            icon={agg.d90 >= 0.2 ? Users : TrendingDown}
            accent={agg.d90 >= 0.2 ? "emerald" : agg.d90 >= 0.05 ? "amber" : "rose"}
          />
        </div>

        {data.series.length === 0 ? (
          <EmptyState
            icon={Percent}
            title="No retention data"
            description="No signups in the last 180 days have aged enough to produce a curve."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Retention curve — day 0 through day 90
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Each point = fraction of cohort (users with signup_at ≤ now−N
                days) that placed a wager on day N.
              </p>
            </CardHeader>
            <CardContent>
              <MultiRetentionChart series={data.series} />
            </CardContent>
          </Card>
        )}

        {data.series.length > 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">By breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{bk === "country" ? "Country" : "Source"}</TableHead>
                    <TableHead className="text-right">Cohort</TableHead>
                    <TableHead className="text-right">D1</TableHead>
                    <TableHead className="text-right">D7</TableHead>
                    <TableHead className="text-right">D30</TableHead>
                    <TableHead className="text-right">D90</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.series.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className="font-medium">{s.label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.cohort)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(s.d1 * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(s.d7 * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(s.d30 * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(s.d90 * 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </FadeIn>
  );
}

function aggregate(series: { cohort: number; d1: number; d7: number; d30: number; d90: number }[]) {
  if (series.length === 0) return { cohort: 0, d1: 0, d7: 0, d30: 0, d90: 0 };
  if (series.length === 1) return series[0];
  // Weighted by cohort size — straight average would over-weight tiny
  // buckets with one-off retention spikes.
  let cohort = 0;
  let d1 = 0;
  let d7 = 0;
  let d30 = 0;
  let d90 = 0;
  for (const s of series) {
    cohort += s.cohort;
    d1 += s.d1 * s.cohort;
    d7 += s.d7 * s.cohort;
    d30 += s.d30 * s.cohort;
    d90 += s.d90 * s.cohort;
  }
  if (cohort === 0) return { cohort: 0, d1: 0, d7: 0, d30: 0, d90: 0 };
  return {
    cohort,
    d1: d1 / cohort,
    d7: d7 / cohort,
    d30: d30 / cohort,
    d90: d90 / cohort,
  };
}

function Intro({ breakdownBy }: { breakdownBy: RetentionBreakdownKey }) {
  const label =
    breakdownBy === "source"
      ? " split by signup source"
      : breakdownBy === "country"
        ? " split by country"
        : "";
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
      <div className="rounded-md bg-primary/10 p-1.5">
        <Percent className="size-4 text-primary" />
      </div>
      <div className="text-sm">
        <h3 className="font-semibold">Retention curves{label}</h3>
        <p className="text-muted-foreground">
          % of cohort (users signed up at least N days ago) that placed a wager
          on day N. Cohort = signups in the last 180 days. Higher = stickier.
        </p>
      </div>
    </div>
  );
}

function BreakdownToggle({ current }: { current: RetentionBreakdownKey }) {
  const options: { value: RetentionBreakdownKey; label: string }[] = [
    { value: "none", label: "Overall" },
    { value: "source", label: "By source" },
    { value: "country", label: "By country" },
  ];
  return (
    <div className="flex gap-1 rounded-md border bg-muted/40 p-1 self-start w-fit">
      {options.map(({ value, label }) => (
        <Link
          key={value}
          href={`?tab=retention&retentionBy=${value}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
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
