import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeDollarSign,
  CalendarDays,
  Gift,
  Receipt,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { AnimatedNumber } from "@/components/animated-number";
import { SectionHeading } from "@/components/modern-panels";
import { PeriodChips } from "@/components/ux";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { REWARD_QUERY_TIMEOUT_MS, safeQuery } from "@/lib/errors/safe-query";
import {
  FINANCE_PERIODS,
  financePeriodLabel,
  financeWeekDateRange,
  parseFinancePeriod,
  type FinancePeriod,
} from "@/lib/finances/periods";
import { houseAmountTextClass } from "@/lib/house-pov";
import {
  getActualExpenseSummary,
  getFinanceProfit,
  getSalaryExpenseSummary,
} from "@/lib/queries/finances-overview";
import { requireMotha } from "@/lib/salary/motha-gate";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

import { FinanceCardSkeleton, FinancesOverviewSkeleton } from "./skeleton";

export const metadata = { title: "Finances" };

type PageProps = {
  searchParams: Promise<{ period?: string }>;
};

export default async function FinancesPage({ searchParams }: PageProps) {
  await requireMotha();
  const { period: rawPeriod } = await searchParams;
  const period = parseFinancePeriod(rawPeriod);

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={Wallet}
        title="Finances overview"
        action={
          <Link
            href="/salaries"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Manage salaries
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
      />

      {/* `FinancesOverview` is synchronous — it only STARTS the reads and
          hands each one to its own boundary below, so this outer fallback
          is never actually painted. The boundary is kept because it is
          what re-arms the inner ones when `period` changes, and it is the
          Suspense parent the client `PeriodChips` island renders under. */}
      <Suspense key={period} fallback={<FinancesOverviewSkeleton />}>
        <FinancesOverview period={period} />
      </Suspense>
    </div>
  );
}

type FinanceProfitData = Awaited<ReturnType<typeof getFinanceProfit>>;
type SalarySummaryData = Awaited<ReturnType<typeof getSalaryExpenseSummary>>;
type ExpenseSummaryData = Awaited<ReturnType<typeof getActualExpenseSummary>>;

/** `safeQuery` never rejects — it resolves to `{ data, error }` — so its
 *  promises are safe to create here and await inside the children. */
type QueryResult<T> = Promise<{ data: T | null }>;

/**
 * Starts all four reads in parallel (exactly as the previous single
 * `Promise.all` did — same queries, same count) but gives each tile its
 * OWN Suspense boundary.
 *
 * Why: the four legs have wildly different costs. The salary summary is a
 * single Admin-DB aggregate; the actual-expense summary fans out over
 * reward + creator cost reads on the MAIN mirror. Awaiting them together
 * meant every tile waited for the slowest, and a leg that burned its full
 * 15s `safeQuery` budget held the ENTIRE grid blank for 15s before
 * painting three good tiles next to one failure band. Per-tile boundaries
 * let each number land when it is ready and confine a slow/failed leg to
 * its own card.
 *
 * This function stays synchronous on purpose: it must not await anything,
 * or the static Profit header below would go back to being gated on data.
 */
function FinancesOverview({ period }: { period: FinancePeriod }) {
  const now = new Date();
  const profitPromise = safeQuery(
    () => getFinanceProfit(period, now),
    null,
    `finances.profit.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  // When the selected window IS the accounting week, the Weekly card and
  // the Profit card want the identical number — share the one promise
  // rather than paying a second P&L read against the globally capped
  // mirror pool.
  const weeklyProfitPromise =
    period === "7d"
      ? profitPromise
      : safeQuery(
          () => getFinanceProfit("7d", now),
          null,
          "finances.profit.7d",
          REWARD_QUERY_TIMEOUT_MS,
        );
  const salaryPromise = safeQuery(
    () => getSalaryExpenseSummary(period),
    null,
    `finances.salaryExpenses.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  const expensePromise = safeQuery(
    () => getActualExpenseSummary(period, now),
    null,
    `finances.actualExpenses.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );

  const label = financePeriodLabel(period);
  const weekRange = financeWeekDateRange(now);
  const selectedPeriodCaption =
    period === "7d" ? `Week to date · ${weekRange} UTC` : `Last ${label}`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Suspense fallback={<FinanceCardSkeleton />}>
        <WeeklyProfitCard promise={weeklyProfitPromise} weekRange={weekRange} />
      </Suspense>

      {/* Profit card — the header, INCLUDING the period chips, is static.
          The chips are the control the admin uses to change window, so
          they must paint immediately and stay on screen while the new
          window streams in behind the content boundary below. Only the
          trend icon depends on the data, so it gets its own hair-thin
          boundary rather than dragging the whole header back behind the
          read. */}
      <Card className="min-h-[310px]">
        <CardHeader className="gap-3 border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Suspense
                  fallback={<Skeleton className="size-4 shrink-0 rounded" />}
                >
                  <ProfitTrendIcon promise={profitPromise} />
                </Suspense>
                Profit
              </CardTitle>
              <CardDescription>
                Balance-sheet P&amp;L for the selected period
              </CardDescription>
            </div>
            <PeriodChips
              items={FINANCE_PERIODS}
              current={period}
              paramKey="period"
              defaultValue="24h"
              ariaNoun="profit period"
              className="self-start"
              spinnerSize={12}
            />
          </div>
        </CardHeader>

        <Suspense fallback={<ProfitContentFallback />}>
          <ProfitCardContent
            promise={profitPromise}
            caption={selectedPeriodCaption}
          />
        </Suspense>
      </Card>

      <Suspense fallback={<FinanceCardSkeleton />}>
        <SalaryExpensesCard
          promise={salaryPromise}
          caption={period === "7d" ? `${weekRange} UTC` : `Last ${label}`}
        />
      </Suspense>

      <Suspense fallback={<FinanceCardSkeleton />}>
        <ActualExpensesCard
          promise={expensePromise}
          caption={selectedPeriodCaption}
        />
      </Suspense>
    </div>
  );
}

async function WeeklyProfitCard({
  promise,
  weekRange,
}: {
  promise: QueryResult<FinanceProfitData>;
  weekRange: string;
}) {
  const { data: weeklyProfit } = await promise;

  return (
    <Card className="min-h-[310px]">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <BadgeDollarSign
            className={cn(
              "size-4",
              weeklyProfit && weeklyProfit.pnl < 0
                ? "text-rose-500"
                : "text-emerald-500",
            )}
            aria-hidden
          />
          Weekly P&amp;L
        </CardTitle>
        <CardDescription>{weekRange} · UTC</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-5">
        {weeklyProfit ? (
          <>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {weeklyProfit.pnl >= 0
                  ? "Profit this week to date"
                  : "Loss this week to date"}
              </p>
              <p
                className={cn(
                  "mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl",
                  houseAmountTextClass(weeklyProfit.pnl),
                )}
              >
                {weeklyProfit.pnl >= 0 ? "+" : "−"}
                <AnimatedNumber
                  value={Math.abs(weeklyProfit.pnl)}
                  format="currency"
                />
              </p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Current Monday–Sunday accounting week using the same
              balance-sheet definition as the Profit card.
            </p>
          </>
        ) : (
          <Unavailable message="Weekly P&L could not be loaded. Refresh to retry." />
        )}
      </CardContent>
    </Card>
  );
}

async function ProfitTrendIcon({
  promise,
}: {
  promise: QueryResult<FinanceProfitData>;
}) {
  const { data: profit } = await promise;
  return profit && profit.pnl < 0 ? (
    <TrendingDown className="size-4 text-rose-500" aria-hidden />
  ) : (
    <TrendingUp className="size-4 text-emerald-500" aria-hidden />
  );
}

function ProfitContentFallback() {
  return (
    <CardContent className="flex flex-1 flex-col justify-between gap-5">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-12 w-48" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-16 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-4 w-full" />
    </CardContent>
  );
}

async function ProfitCardContent({
  promise,
  caption,
}: {
  promise: QueryResult<FinanceProfitData>;
  caption: string;
}) {
  const { data: profit } = await promise;

  return (
    <CardContent className="flex flex-1 flex-col justify-between gap-5">
      {profit ? (
        <>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {caption}
            </p>
            <p
              className={cn(
                "mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl",
                houseAmountTextClass(profit.pnl),
              )}
            >
              {profit.pnl >= 0 ? "+" : "−"}
              <AnimatedNumber value={Math.abs(profit.pnl)} format="currency" />
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <ProfitDetail
              label="Deposits"
              value={profit.deposits}
              tone="positive"
            />
            <ProfitDetail
              label="Withdrawals"
              value={profit.withdrawals}
              tone="negative"
            />
            <ProfitDetail
              label="Holdings Δ"
              value={
                profit.balanceChange +
                profit.inventoryChange +
                profit.voucherChange
              }
              tone="neutral"
              signed
            />
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Deposits − withdrawals − change in user balances, inventory,
            and vouchers. This is the same profit definition used on the
            dashboard.
          </p>
        </>
      ) : (
        <Unavailable message="Profit data could not be loaded. Refresh to retry." />
      )}
    </CardContent>
  );
}

async function SalaryExpensesCard({
  promise,
  caption,
}: {
  promise: QueryResult<SalarySummaryData>;
  caption: string;
}) {
  const { data: salaries } = await promise;

  return (
    <Card className="min-h-[310px]">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Receipt className="size-4 text-amber-500" aria-hidden />
          Salary expenses
        </CardTitle>
        <CardDescription>Active team commitments</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-5">
        {salaries ? (
          <>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {caption}
              </p>
              <p className="mt-1 text-4xl font-bold tracking-tight text-rose-600 tabular-nums dark:text-rose-400 sm:text-5xl">
                −
                <AnimatedNumber
                  value={salaries.periodExpense}
                  format="currency"
                />
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Projected USDT salary expense
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <SalaryDetail
                icon={CalendarDays}
                label="Monthly"
                value={formatCurrency(salaries.monthly)}
              />
              <SalaryDetail
                icon={Receipt}
                label="Annual"
                value={formatCurrency(salaries.annual)}
              />
              <SalaryDetail
                icon={Users}
                label="Employees"
                value={String(salaries.activeEmployees)}
              />
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Based on active salary records and prorated from a 30-day
              operating month to match the selected profit period.
            </p>
          </>
        ) : (
          <Unavailable message="Salary expenses could not be loaded. Refresh to retry." />
        )}
      </CardContent>
    </Card>
  );
}

async function ActualExpensesCard({
  promise,
  caption,
}: {
  promise: QueryResult<ExpenseSummaryData>;
  caption: string;
}) {
  const { data: expenses } = await promise;

  return (
    <Card className="min-h-[310px]">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Gift className="size-4 text-rose-500" aria-hidden />
          Actual expenses
        </CardTitle>
        <CardDescription>Rewards and creator programs</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-5">
        {expenses ? (
          <>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {caption}
              </p>
              <p className="mt-1 text-4xl font-bold tracking-tight text-rose-600 tabular-nums dark:text-rose-400 sm:text-5xl">
                −<AnimatedNumber value={expenses.total} format="currency" />
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Real costs recognized in the selected period
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SalaryDetail
                icon={Gift}
                label="Rewards + affiliate prizes"
                value={formatCurrency(expenses.rewardsAndAffiliatePrizes)}
              />
              <SalaryDetail
                icon={Users}
                label="Creator programs"
                value={formatCurrency(expenses.creatorPrograms)}
              />
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Actual reward payouts, net house-funded rain, creator deal
              payouts, tips, and sponsored battles. No salary run rate.
            </p>
          </>
        ) : (
          <Unavailable message="Actual expenses could not be loaded. Refresh to retry." />
        )}
      </CardContent>
    </Card>
  );
}

function ProfitDetail({
  label,
  value,
  tone,
  signed = false,
}: {
  label: string;
  value: number;
  tone: "positive" | "negative" | "neutral";
  signed?: boolean;
}) {
  const prefix = signed && value > 0 ? "+" : signed && value < 0 ? "−" : "";
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-2.5">
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-sm font-semibold tabular-nums",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400",
          tone === "negative" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {prefix}
        {formatCurrency(Math.abs(value))}
      </p>
    </div>
  );
}

function SalaryDetail({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3" aria-hidden />
        <p className="truncate text-[10px] font-medium uppercase tracking-wider">
          {label}
        </p>
      </div>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}
