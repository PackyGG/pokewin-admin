import { Suspense } from "react";
import { getAnalyticsData } from "@/lib/queries/analytics";
import { compareAnalyticsOverview } from "@/lib/clickhouse/compare/analytics-overview";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getAnalyticsDataFromClickHouse } from "@/lib/clickhouse/queries/analytics/overview";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getPackBattlePurePnl } from "@/lib/queries/pnl";
import {
  getTopDepositors,
  type LeaderboardPeriod,
} from "@/lib/queries/analytics-top";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { Skeleton } from "@/components/ui/skeleton";
import { AnalyticsCharts } from "./charts";
import { FadeIn } from "@/components/fade-in";
import {
  ConcentrationSection,
  CostStackSection,
  DailyMoneyTable,
  GameMixSection,
  HeadlineSection,
  TrafficStrip,
} from "./overview-sections";
import type { AnalyticsPeriod } from "./types";

/**
 * /analytics Overview — the money story, top to bottom.
 *
 * Rebuilt 2026-07-23 (owner: "a lot of useless shit and not all infos we
 * need"). The old tab was a KPI wall — nine stat cards, then three P&L
 * panels that each said a slightly different thing. It answered "what are
 * the numbers" but never "are we making money, off whom, and what's
 * leaking".
 *
 * The order below IS the argument, and each section earns its place:
 *   1. House profit + the ladder that produces it — the one number.
 *   2. Deposits / withdrawals / players — context, deliberately small.
 *   3. Cost stack ranked by $, each as % of DEPOSITS — the affordability
 *      question, which raw dollar costs can't answer.
 *   4. Wager mix + MEASURED hold per mode — is a mode running hot.
 *   5. Depositor concentration — whale risk in one line.
 *   6. Day-by-day money table — the spreadsheet nobody should have to build.
 *   7. The existing trend charts, unchanged.
 *
 * Everything composes queries that already exist and are already proven
 * (getAnalyticsData, getPackBattlePurePnl, getTopDepositors) — no new heavy
 * aggregate against MAIN, so the Index-or-ClickHouse rule is satisfied by
 * construction. Each independent read streams behind its own Suspense with
 * safeQuery, so one slow leg never blanks the page.
 */
export async function OverviewTab({ period }: { period: AnalyticsPeriod }) {
  const { data, error } = await safeQuery(
    () =>
      resolveAdminRead<Awaited<ReturnType<typeof getAnalyticsData>>>(
        "analytics_overview",
        {
          pg: () => getAnalyticsData(period),
          ch: async () =>
            getAnalyticsDataFromClickHouse(period, await getExcludedUserIds()),
        },
      ),
    null,
    "analytics.overview",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Analytics overview"
        hint="The overview metrics query failed — refresh or switch period to retry."
        size="panel"
      />
    );
  }

  // Comparison-mode ClickHouse twin (fire-and-forget). No-op unless the
  // `analytics_overview` surface is in `comparison` mode; never awaited,
  // swallows its own errors, and never affects the rendered Postgres payload.
  void compareAnalyticsOverview(period, data);

  return (
    <div className="space-y-6">
      <HeadlineSection data={data} />
      <TrafficStrip data={data} />

      <CostStackSection data={data} />

      {/* Measured hold needs the pure-margin windows — its own leg so the
          sections above paint without waiting on that scan. */}
      <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
        <GameMixLeg data={data} />
      </Suspense>

      {/* Concentration needs the depositor leaderboard — same treatment. */}
      <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
        <ConcentrationLeg
          period={period}
          deposits={data.realizedProfitBreakdown.totalDeposits}
        />
      </Suspense>

      <DailyMoneyTable data={data} />

      <FadeIn>
        <AnalyticsCharts data={data.daily} />
      </FadeIn>
    </div>
  );
}

/**
 * Measured pack/battle hold. The pure-margin query is window-fixed
 * (24h/3d/7d/lifetime) and period-independent, so it streams separately and
 * degrades to a null (the section renders its own "unavailable" line).
 */
async function GameMixLeg({
  data,
}: {
  data: Awaited<ReturnType<typeof getAnalyticsData>>;
}) {
  const { data: pure } = await safeQuery(
    () => getPackBattlePurePnl(),
    null,
    "analytics.overview.purePnl",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return <GameMixSection data={data} pure={pure} />;
}

/**
 * Depositor concentration.
 *
 * The leaderboard only exists for 7d / 30d / lifetime windows. Rather than
 * divide a 7-day top-10 by a 90-day deposit total — which would print a
 * confidently wrong percentage — an unalignable period renders the
 * explanation instead. `today` maps to nothing, not to 7d.
 */
function leaderboardWindowFor(
  period: AnalyticsPeriod,
): { key: LeaderboardPeriod; label: string } | null {
  switch (period) {
    case "7d":
      return { key: "7d", label: "last 7 days" };
    case "30d":
      return { key: "30d", label: "last 30 days" };
    case "all":
      return { key: "all", label: "lifetime" };
    default:
      return null;
  }
}

async function ConcentrationLeg({
  period,
  deposits,
}: {
  period: AnalyticsPeriod;
  deposits: number;
}) {
  const window = leaderboardWindowFor(period);
  if (!window) {
    return (
      <ConcentrationSection deposits={deposits} top={null} windowLabel={null} />
    );
  }
  const { data: top } = await safeQuery(
    () => getTopDepositors(window.key),
    null,
    "analytics.overview.concentration",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return (
    <ConcentrationSection
      deposits={deposits}
      top={top}
      windowLabel={top ? window.label : null}
    />
  );
}
