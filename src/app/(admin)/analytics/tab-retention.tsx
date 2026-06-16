import { Percent, Users, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { FadeIn } from "@/components/fade-in";
import { MetricTile } from "@/components/modern-panels";
import { getRetentionCurve } from "@/lib/queries/analytics-retention";
import { compareRetention } from "@/lib/clickhouse/compare/analytics-retention";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRetentionCurveFromClickHouse } from "@/lib/clickhouse/queries/analytics/retention";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { RetentionChart } from "./retention-chart";
import type { AnalyticsPeriod } from "./types";

/**
 * Retention curve and churn KPIs. The hero period filter is ignored —
 * retention is a rolling 180-day cohort measurement by design.
 */
export async function RetentionTab({
  period: _period,
}: {
  period: AnalyticsPeriod;
}) {
  void _period;
  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getRetentionCurve>>>(
        "analytics_retention",
        {
          pg: () => getRetentionCurve(),
          ch: async () =>
            getRetentionCurveFromClickHouse(await getExcludedUserIds()),
        },
      ),
    null,
    "analytics.retention",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Retention / churn"
        hint="The retention query failed — refresh to retry."
        size="panel"
      />
    );
  }
  // Fire-and-forget ClickHouse comparison (no-op unless the
  // `analytics_retention` surface is in comparison mode). Never affects the
  // served Postgres payload.
  void compareRetention(data);

  const kpis = [
    {
      label: "D1 Retention",
      pct: data.d1,
      cohort: data.cohortD1,
    },
    {
      label: "D7 Retention",
      pct: data.d7,
      cohort: data.cohortD7,
    },
    {
      label: "D30 Retention",
      pct: data.d30,
      cohort: data.cohortD30,
    },
    {
      label: "D90 Retention",
      pct: data.d90,
      cohort: data.cohortD90,
    },
  ];

  return (
    <FadeIn>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Percent className="size-4 text-primary" />
          </div>
          <div className="text-sm">
            <h3 className="font-semibold">Retention / churn</h3>
            <p className="text-muted-foreground">
              % of signups that were still wagering N days after sign-up.
              Cohort = everyone who signed up in the last 180 days. Churn
              = 1 − retention at a given day. D1 is always high for
              users who signed up today (wager day-of counts); the
              interesting signal is how steeply the curve drops.
            </p>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((k) => (
            <MetricTile
              key={k.label}
              label={k.label}
              value={`${(k.pct * 100).toFixed(1)}%`}
              icon={k.pct >= 0.2 ? Users : TrendingDown}
              accent={k.pct >= 0.2 ? "emerald" : k.pct >= 0.05 ? "amber" : "rose"}
              sub={`${formatNumber(k.cohort)} eligible users`}
            />
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Retention curve — day 0 through day 90
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Each point = fraction of cohort (users that signed up at least
              N days ago) that placed a wager on day N.
            </p>
          </CardHeader>
          <CardContent>
            <RetentionChart curve={data.curve} />
          </CardContent>
        </Card>
      </div>
    </FadeIn>
  );
}
