import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight, BadgeDollarSign, Wallet } from "lucide-react";

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
  financePeriodSince,
  financePeriodLabel,
  financeWeekDateRange,
  parseFinancePeriod,
  type FinancePeriod,
} from "@/lib/finances/periods";
import { buildFinanceProfitTimeline } from "@/lib/finances/profit-timeline";
import { calculateNetProfit } from "@/lib/finances/weekly-profit";
import { houseAmountTextClass } from "@/lib/house-pov";
import {
  getFinanceDailyPnl,
  getFinanceGamingSummary,
  getFinanceProfit,
  getOperatingExpenseSummary,
  getSalaryExpenseSummary,
} from "@/lib/queries/finances-overview";
import { requireMotha } from "@/lib/salary/motha-gate";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

import { FinanceProfitTimeline } from "./finance-profit-timeline";
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <FinanceLink href="/finances/expenses">Expenses</FinanceLink>
            <FinanceLink href="/finances/subscriptions">
              Subscriptions
            </FinanceLink>
            <FinanceLink href="/salaries">Salaries</FinanceLink>
          </div>
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

function FinanceLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      {children}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

type FinanceProfitData = Awaited<ReturnType<typeof getFinanceProfit>>;
type SalarySummaryData = Awaited<ReturnType<typeof getSalaryExpenseSummary>>;
type OperatingExpenseData = Awaited<
  ReturnType<typeof getOperatingExpenseSummary>
>;
type DailyPnlData = Awaited<ReturnType<typeof getFinanceDailyPnl>>;
type GamingSummaryData = Awaited<ReturnType<typeof getFinanceGamingSummary>>;

/** `safeQuery` never rejects — it resolves to `{ data, error }` — so its
 *  promises are safe to create here and await inside the children. */
type QueryResult<T> = Promise<{ data: T | null }>;

/**
 * Starts the reads in parallel but gives each tile its OWN Suspense boundary.
 *
 * The selected-period cash P&L is a MAIN-mirror read while salary,
 * subscriptions, and logged expenses are Admin-DB aggregates. Per-tile
 * boundaries let each number land when it is ready and confine a slow or
 * failed leg to its own card.
 *
 * This function stays synchronous on purpose: it must not await anything,
 * or the static Profit header below would go back to being gated on data.
 */
function FinancesOverview({ period }: { period: FinancePeriod }) {
  const now = new Date();
  const since = financePeriodSince(period, now);
  const profitPromise = safeQuery(
    () => getFinanceProfit(period, now),
    null,
    `finances.profit.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  const salaryPromise = safeQuery(
    () => getSalaryExpenseSummary(period, now),
    null,
    `finances.salaryExpenses.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  const operatingExpensePromise = safeQuery(
    () => getOperatingExpenseSummary(period, now),
    null,
    `finances.operatingExpenses.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  const dailyPnlPromise = safeQuery(
    () => getFinanceDailyPnl(period, now),
    [],
    `finances.dailyPnl.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  const gamingPromise = safeQuery(
    () => getFinanceGamingSummary(period, now),
    null,
    `finances.gaming.${period}`,
    REWARD_QUERY_TIMEOUT_MS,
  );
  const label = financePeriodLabel(period);
  const weekRange = financeWeekDateRange(now);
  const selectedPeriodCaption =
    period === "7d" ? `Week to date · ${weekRange} UTC` : `Last ${label}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BadgeDollarSign
                  className="size-4 text-emerald-500"
                  aria-hidden
                />
                Net result
              </CardTitle>
              <CardDescription>
                What the business made after every tracked operating cost
              </CardDescription>
            </div>
            <PeriodChips
              items={FINANCE_PERIODS}
              current={period}
              paramKey="period"
              defaultValue="7d"
              ariaNoun="net profit period"
              className="self-start"
              spinnerSize={12}
            />
          </div>
        </CardHeader>
        <Suspense fallback={<NetProfitContentFallback />}>
          <NetProfitContent
            cashProfitPromise={profitPromise}
            salaryPromise={salaryPromise}
            operatingExpensePromise={operatingExpensePromise}
            caption={selectedPeriodCaption}
          />
        </Suspense>
      </Card>

      <Suspense fallback={<FinanceCardSkeleton />}>
        <ProfitTimelineLeg
          dailyPnlPromise={dailyPnlPromise}
          salaryPromise={salaryPromise}
          operatingExpensePromise={operatingExpensePromise}
          since={since}
          through={now}
          caption={selectedPeriodCaption}
        />
      </Suspense>

      <Suspense fallback={<FinanceCardSkeleton />}>
        <RevenueToProfitBridge
          gamingPromise={gamingPromise}
          cashProfitPromise={profitPromise}
          salaryPromise={salaryPromise}
          operatingExpensePromise={operatingExpensePromise}
          caption={selectedPeriodCaption}
        />
      </Suspense>
    </div>
  );
}

async function NetProfitContent({
  cashProfitPromise,
  salaryPromise,
  operatingExpensePromise,
  caption,
}: {
  cashProfitPromise: QueryResult<FinanceProfitData>;
  salaryPromise: QueryResult<SalarySummaryData>;
  operatingExpensePromise: QueryResult<OperatingExpenseData>;
  caption: string;
}) {
  const { data: cashProfit } = await cashProfitPromise;
  const { data: salary } = await salaryPromise;
  const { data: operatingExpenses } = await operatingExpensePromise;
  const netProfit =
    cashProfit && salary && operatingExpenses
      ? calculateNetProfit({
          cashProfit: cashProfit.pnl,
          salaryExpense: salary.periodExpense,
          subscriptionExpense: operatingExpenses.subscriptionExpense,
          oneTimeExpenses: operatingExpenses.oneTimeExpenses,
        })
      : null;

  return (
    <CardContent className="space-y-5">
      {netProfit ? (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)_minmax(0,0.75fr)] lg:divide-x">
            <div className="lg:pr-6">
              <p className="text-xs font-medium text-muted-foreground">
                {netProfit.netProfit >= 0 ? "Net profit" : "Net loss"}
              </p>
              <p
                className={cn(
                  "mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl",
                  houseAmountTextClass(netProfit.netProfit),
                )}
              >
                {netProfit.netProfit >= 0 ? "+" : "−"}
                <AnimatedNumber
                  value={Math.abs(netProfit.netProfit)}
                  format="currency"
                />
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{caption}</p>
            </div>

            <SummaryMetric
              label="Cash P&L"
              hint="Before operating costs"
              value={netProfit.cashProfit}
              tone={netProfit.cashProfit >= 0 ? "positive" : "negative"}
              signed
            />
            <SummaryMetric
              label="Operating costs"
              hint="Deducted from cash P&L"
              value={netProfit.operatingCosts}
              tone="negative"
              prefix="−"
            />
          </div>

          <div className="grid border-y sm:grid-cols-3 sm:divide-x">
            <CostBreakdownItem
              href="/salaries"
              label="Salary accrual"
              value={netProfit.salaryExpense}
            />
            <CostBreakdownItem
              href="/finances/subscriptions"
              label="Subscriptions"
              value={netProfit.subscriptionExpense}
            />
            <CostBreakdownItem
              href="/finances/expenses"
              label="Logged expenses"
              value={netProfit.oneTimeExpenses}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Cash P&amp;L − operating costs = net result. Recurring costs are
            prorated to the exact window; expenses use their recorded date.
          </p>
        </>
      ) : (
        <Unavailable message="Net profit could not be loaded. Refresh to retry." />
      )}
    </CardContent>
  );
}

function NetProfitContentFallback() {
  return (
    <CardContent className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
      </div>
      <div className="grid border-y sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="m-3 h-10 rounded-md" />
        ))}
      </div>
    </CardContent>
  );
}

async function ProfitTimelineLeg({
  dailyPnlPromise,
  salaryPromise,
  operatingExpensePromise,
  since,
  through,
  caption,
}: {
  dailyPnlPromise: QueryResult<DailyPnlData>;
  salaryPromise: QueryResult<SalarySummaryData>;
  operatingExpensePromise: QueryResult<OperatingExpenseData>;
  since: Date;
  through: Date;
  caption: string;
}) {
  const { data: dailyPnl } = await dailyPnlPromise;
  const { data: salary } = await salaryPromise;
  const { data: operatingExpenses } = await operatingExpensePromise;

  if (!dailyPnl || !salary || !operatingExpenses) {
    return (
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Profit timeline</CardTitle>
          <CardDescription>{caption}</CardDescription>
        </CardHeader>
        <CardContent>
          <Unavailable message="The profit timeline could not be loaded. Refresh to retry." />
        </CardContent>
      </Card>
    );
  }

  const timeline = buildFinanceProfitTimeline({
    since,
    through,
    dailyPnl,
    monthlySalary: salary.monthly,
    monthlySubscriptions: operatingExpenses.monthlySubscriptions,
    oneTimeByDate: operatingExpenses.oneTimeByDate,
  });

  return <FinanceProfitTimeline data={timeline} caption={caption} />;
}

async function RevenueToProfitBridge({
  gamingPromise,
  cashProfitPromise,
  salaryPromise,
  operatingExpensePromise,
  caption,
}: {
  gamingPromise: QueryResult<GamingSummaryData>;
  cashProfitPromise: QueryResult<FinanceProfitData>;
  salaryPromise: QueryResult<SalarySummaryData>;
  operatingExpensePromise: QueryResult<OperatingExpenseData>;
  caption: string;
}) {
  const { data: gaming } = await gamingPromise;
  const { data: cashProfit } = await cashProfitPromise;
  const { data: salary } = await salaryPromise;
  const { data: operatingExpenses } = await operatingExpensePromise;

  const profit =
    cashProfit && salary && operatingExpenses
      ? calculateNetProfit({
          cashProfit: cashProfit.pnl,
          salaryExpense: salary.periodExpense,
          subscriptionExpense: operatingExpenses.subscriptionExpense,
          oneTimeExpenses: operatingExpenses.oneTimeExpenses,
        })
      : null;

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Revenue-to-profit bridge</CardTitle>
        <CardDescription>
          From gaming activity to the amount the business kept · {caption}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {gaming && profit ? (
          <>
            <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-5">
              <BridgeStep
                label="Wager"
                value={gaming.wager}
                hint="Staked volume"
                tone="neutral"
              />
              <BridgeStep
                label="GGR"
                value={gaming.ggr}
                hint="Wager − gaming payouts"
                tone={gaming.ggr >= 0 ? "positive" : "negative"}
                signed
              />
              <BridgeStep
                label="Cash P&L"
                value={profit.cashProfit}
                hint="Balance-sheet result"
                tone={profit.cashProfit >= 0 ? "positive" : "negative"}
                signed
              />
              <BridgeStep
                label="Operating costs"
                value={profit.operatingCosts}
                hint="Salary + tools + expenses"
                tone="negative"
                prefix="−"
              />
              <BridgeStep
                label="Final net"
                value={profit.netProfit}
                hint="Cash P&L − costs"
                tone={profit.netProfit >= 0 ? "positive" : "negative"}
                signed
                emphasized
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Wager is activity volume and GGR is gaming margin. Cash P&amp;L
              reconciles gaming activity with deposits, withdrawals, user
              holdings, inventory, and vouchers before tracked operating costs
              are deducted.
            </p>
          </>
        ) : (
          <Unavailable message="The revenue-to-profit bridge could not be loaded. Refresh to retry." />
        )}
      </CardContent>
    </Card>
  );
}

function BridgeStep({
  label,
  value,
  hint,
  tone,
  signed = false,
  prefix,
  emphasized = false,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "positive" | "negative" | "neutral";
  signed?: boolean;
  prefix?: string;
  emphasized?: boolean;
}) {
  const sign = prefix ?? (signed ? (value >= 0 ? "+" : "−") : "");

  return (
    <div className={cn("min-w-0 p-4", emphasized ? "bg-muted" : "bg-card")}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 truncate text-xl font-bold tracking-tight tabular-nums",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400",
          tone === "negative" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {sign}
        {formatCurrency(Math.abs(value))}
      </p>
      <p className="mt-1 truncate text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function SummaryMetric({
  label,
  hint,
  value,
  tone,
  signed = false,
  prefix,
}: {
  label: string;
  hint: string;
  value: number;
  tone: "positive" | "negative";
  signed?: boolean;
  prefix?: string;
}) {
  const sign = prefix ?? (signed ? (value >= 0 ? "+" : "−") : "");
  return (
    <div className="min-w-0 lg:px-6">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 truncate text-2xl font-semibold tracking-tight tabular-nums",
          tone === "positive"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        {sign}
        {formatCurrency(Math.abs(value))}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function CostBreakdownItem({
  href,
  label,
  value,
}: {
  href: string;
  label: string;
  value: number;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 px-3 py-3 transition-colors hover:bg-muted/35"
    >
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-semibold text-rose-600 tabular-nums dark:text-rose-400">
          −{formatCurrency(Math.abs(value))}
        </p>
      </div>
      <ArrowRight
        className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}
