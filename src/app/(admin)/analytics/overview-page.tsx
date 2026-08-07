import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { getAnalyticsData } from "@/lib/queries/analytics";
import {
  getDailyPnl,
  getPackBattlePurePnl,
  type DailyPnlWindowDays,
} from "@/lib/queries/pnl";
import {
  getTopDepositors,
  type LeaderboardPeriod,
} from "@/lib/queries/analytics-top";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency } from "@/lib/utils/format";
import { RevenueTrendChart, WagerMixChart, RewardLegsChart } from "./charts";
import { MoneyFlowChart } from "./money-flow-chart";
import {
  ConcentrationSection,
  CostStackSection,
  DailyMoneyTable,
  GameMixSection,
  HeadlineSection,
  periodDeposits,
  TrafficStrip,
  WithdrawalRailsSection,
} from "./overview-sections";
import { getWithdrawnCoinsBreakdown } from "@/lib/queries/analytics-withdrawals";
import { toAcquisitionWindow, type AnalyticsPeriod } from "./types";

/**
 * /analytics core — everything below the Acquisition section on the one-page
 * overview (2026-08 redesign: the tab wall became a single scroll; the
 * specialist tabs survive as deep dives behind `?tab=`).
 *
 * The scroll IS the argument, top to bottom:
 *   1. Traffic context — deposits / wager / players / signups, small.
 *   2. Money in & out — daily deposits vs withdrawals with the house P&L
 *      line over them, then which rails the cash left through, then whale
 *      concentration.
 *   3. Revenue — house profit + the ladder that produces it, the GGR/NGR
 *      and wager-mix trends, and measured hold per mode.
 *   4. Costs — the reward stack ranked by $ as % of deposits, and its daily
 *      shape. Depth (waterfall, contributors, per-program) lives in the
 *      Cost Breakdown / Rewards deep dives, linked from the headings.
 *   5. Day-by-day money table — the spreadsheet nobody should have to build.
 *
 * One heavy read (`getAnalyticsData`) feeds every synchronous section, so a
 * chart never disagrees with the number beside it; the independent scans
 * (daily P&L, withdrawal rails, pure margin, leaderboard) stream behind
 * their own Suspense legs so one slow leg never blanks the page.
 */
export async function CoreSections({ period }: { period: AnalyticsPeriod }) {
  const { data, error } = await safeQuery(
    () => getAnalyticsData(period),
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

  const deepDive = (tab: string) =>
    period === "30d"
      ? `/analytics?tab=${tab}`
      : `/analytics?tab=${tab}&period=${period}`;

  return (
    <div className="space-y-6">
      <TrafficStrip data={data} />

      {/* ── Money in & out ─────────────────────────────────────────── */}

      {/* Daily deposits vs withdrawals + the P&L line scan the ledger a
          second way (getDailyPnl) — its own leg so the sections around it
          paint without waiting on that scan. */}
      <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
        <MoneyFlowLeg period={period} />
      </Suspense>

      {/* Withdrawal rails scan `card_withdrawal_requests`, not the ledger —
          its own leg so the headline above paints without waiting on it. */}
      <Suspense fallback={<Skeleton className="h-48 w-full rounded-xl" />}>
        <WithdrawalRailsLeg period={period} />
      </Suspense>

      {/* Concentration needs the depositor leaderboard — same treatment. */}
      <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
        {/* PERIOD deposits, not the lifetime balance-sheet total — the
            leaderboard above it is windowed, so a lifetime denominator would
            print a share that is wrong by the ratio of the two. */}
        <ConcentrationLeg period={period} deposits={periodDeposits(data)} />
      </Suspense>

      {/* ── Revenue ────────────────────────────────────────────────── */}

      <HeadlineSection data={data} />

      <FadeIn>
        <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
          <RevenueTrendChart data={data.daily} />
          <WagerMixChart data={data.daily} />
        </div>
      </FadeIn>

      {/* Measured hold needs the pure-margin windows — its own leg so the
          sections above paint without waiting on that scan. */}
      <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
        <GameMixLeg data={data} gamesHref={deepDive("games")} />
      </Suspense>

      {/* ── Costs ──────────────────────────────────────────────────── */}

      <CostStackSection
        data={data}
        action={
          <span className="flex items-center gap-3 text-xs">
            <Link
              href={deepDive("cost-breakdown")}
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Full cost breakdown →
            </Link>
            <Link
              href={deepDive("rewards")}
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Rewards →
            </Link>
          </span>
        }
      />

      <FadeIn>
        <RewardLegsChart data={data.daily} />
      </FadeIn>

      <DailyMoneyTable data={data} />
    </div>
  );
}

const WINDOW_DAYS: Record<"7d" | "30d" | "90d", DailyPnlWindowDays> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const WINDOW_LABELS: Record<"7d" | "30d" | "90d", string> = {
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
};

/**
 * Daily money flow. Reuses the canonical `getDailyPnl` series (the same
 * windowed-delta formula and scope as the dashboard's Cash & P&L chart), so
 * the deposits/withdrawals/P&L printed here reconcile with the dashboard.
 * The day-window is bounded via `toAcquisitionWindow` (today→7d, all→90d)
 * and the heading says so when it diverges from the page period.
 */
async function MoneyFlowLeg({ period }: { period: AnalyticsPeriod }) {
  const window = toAcquisitionWindow(period);
  const { data: points, error } = await safeQuery(
    () => getDailyPnl(WINDOW_DAYS[window]),
    [],
    "analytics.overview.moneyFlow",
    REWARD_QUERY_TIMEOUT_MS,
  );

  const windowNote =
    window === period
      ? WINDOW_LABELS[window]
      : `${WINDOW_LABELS[window]} (daily view is bounded)`;

  if (error || points.length === 0) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={ArrowLeftRight} title="Money in & out" />
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            The daily money-flow read is unavailable right now — the rest of
            the page is unaffected. Refresh to retry.
          </p>
        </div>
      </div>
    );
  }

  const totals = points.reduce(
    (acc, p) => ({
      deposits: acc.deposits + p.deposits,
      withdrawals: acc.withdrawals + p.withdrawals,
      pnl: acc.pnl + p.pnl,
    }),
    { deposits: 0, withdrawals: 0, pnl: 0 },
  );
  const net = totals.deposits - totals.withdrawals;

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={ArrowLeftRight}
        title="Money in & out"
        action={
          <span className="text-xs text-muted-foreground">{windowNote}</span>
        }
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Deposits
          </p>
          <p className="mt-1 text-xl font-bold tabular-nums text-emerald-500">
            {formatCurrency(totals.deposits)}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Withdrawals
          </p>
          <p className="mt-1 text-xl font-bold tabular-nums text-rose-500">
            {formatCurrency(totals.withdrawals)}
          </p>
        </div>
        <div className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Net cash
          </p>
          <p
            className={`mt-1 text-xl font-bold tabular-nums ${
              net >= 0 ? "text-emerald-500" : "text-rose-500"
            }`}
          >
            {net >= 0 ? "+" : ""}
            {formatCurrency(net)}
          </p>
        </div>
      </div>
      <MoneyFlowChart
        data={points.map((p) => ({
          date: p.date,
          deposits: p.deposits,
          withdrawals: p.withdrawals,
          pnl: p.pnl,
        }))}
      />
    </div>
  );
}

/**
 * Withdrawn cash per rail. Degrades to a null (the section renders its own
 * "unavailable" line) rather than blanking the page.
 */
async function WithdrawalRailsLeg({ period }: { period: AnalyticsPeriod }) {
  const { data } = await safeQuery(
    () => getWithdrawnCoinsBreakdown(period),
    null,
    "analytics.overview.withdrawalRails",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return <WithdrawalRailsSection data={data} />;
}

/**
 * Measured pack/battle hold. The pure-margin query is window-fixed
 * (24h/3d/7d/lifetime) and period-independent, so it streams separately and
 * degrades to a null (the section renders its own "unavailable" line).
 */
async function GameMixLeg({
  data,
  gamesHref,
}: {
  data: Awaited<ReturnType<typeof getAnalyticsData>>;
  gamesHref: string;
}) {
  const { data: pure } = await safeQuery(
    () => getPackBattlePurePnl(),
    null,
    "analytics.overview.purePnl",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return (
    <GameMixSection
      data={data}
      pure={pure}
      action={
        <Link
          href={gamesHref}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Games deep dive →
        </Link>
      }
    />
  );
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
