import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeDollarSign,
  CalendarDays,
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
import { calculateWeeklyProfit } from "@/lib/finances/weekly-profit";
import { houseAmountTextClass } from "@/lib/house-pov";
import {
  getFinanceProfit,
  getSalaryExpenseSummary,
  getWeeklyOperatingExpenseSummary,
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
type WeeklyOperatingExpenseData = Awaited<
  ReturnType<typeof getWeeklyOperatingExpenseSummary>
>;

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
  const weeklyCashProfitPromise =
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
  const weeklySalaryPromise =
    period === "7d"
      ? salaryPromise
      : safeQuery(
          () => getSalaryExpenseSummary("7d"),
          null,
          "finances.salaryExpenses.7d",
          REWARD_QUERY_TIMEOUT_MS,
        );
  const weeklyOperatingExpensePromise = safeQuery(
    () => getWeeklyOperatingExpenseSummary(now),
    null,
    "finances.weeklyOperatingExpenses",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const label = financePeriodLabel(period);
  const weekRange = financeWeekDateRange(now);
  const selectedPeriodCaption =
    period === "7d" ? `Week to date · ${weekRange} UTC` : `Last ${label}`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <Suspense fallback={<FinanceCardSkeleton />}>
          <WeeklyProfitCard
            cashProfitPromise={weeklyCashProfitPromise}
            salaryPromise={weeklySalaryPromise}
            operatingExpensePromise={weeklyOperatingExpensePromise}
            weekRange={weekRange}
          />
        </Suspense>
      </div>

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
                Cash P&amp;L
              </CardTitle>
              <CardDescription>
                Before salaries, subscriptions, and logged expenses
              </CardDescription>
            </div>
            <PeriodChips
              items={FINANCE_PERIODS}
              current={period}
              paramKey="period"
              defaultValue="7d"
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
    </div>
  );
}

async function WeeklyProfitCard({
  cashProfitPromise,
  salaryPromise,
  operatingExpensePromise,
  weekRange,
}: {
  cashProfitPromise: QueryResult<FinanceProfitData>;
  salaryPromise: QueryResult<SalarySummaryData>;
  operatingExpensePromise: QueryResult<WeeklyOperatingExpenseData>;
  weekRange: string;
}) {
  // All three reads were started by the synchronous parent, so these awaits
  // do not serialize their database work.
  const { data: cashProfit } = await cashProfitPromise;
  const { data: salary } = await salaryPromise;
  const { data: operatingExpenses } = await operatingExpensePromise;
  const weeklyProfit =
    cashProfit && salary && operatingExpenses
      ? calculateWeeklyProfit({
          cashProfit: cashProfit.pnl,
          salaryExpense: salary.periodExpense,
          monthlySubscriptions: operatingExpenses.monthlySubscriptions,
          oneTimeExpenses: operatingExpenses.oneTimeExpenses,
        })
      : null;
  const trackedCosts = weeklyProfit
    ? weeklyProfit.salaryExpense +
      weeklyProfit.subscriptionExpense +
      weeklyProfit.oneTimeExpenses
    : 0;

  return (
    <Card className="min-h-[330px]">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <BadgeDollarSign
            className={cn(
              "size-4",
              weeklyProfit && weeklyProfit.netProfit < 0
                ? "text-rose-500"
                : "text-emerald-500",
            )}
            aria-hidden
          />
          Net result this week
        </CardTitle>
        <CardDescription>
          What the business made after every tracked operating cost ·{" "}
          {weekRange} · UTC
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        {weeklyProfit ? (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
              <div className="flex min-h-44 flex-col justify-between rounded-xl border bg-muted/20 p-5">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {weeklyProfit.netProfit >= 0
                      ? "Actual profit after costs"
                      : "Actual loss after costs"}
                  </p>
                  <p
                    className={cn(
                      "mt-2 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl",
                      houseAmountTextClass(weeklyProfit.netProfit),
                    )}
                  >
                    {weeklyProfit.netProfit >= 0 ? "+" : "−"}
                    <AnimatedNumber
                      value={Math.abs(weeklyProfit.netProfit)}
                      format="currency"
                    />
                  </p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  This is the number to use when asking what we made this week.
                </p>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Money flow
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <MoneyFlowMetric
                    label="Cash P&L"
                    hint="Before operating costs"
                    value={weeklyProfit.cashProfit}
                    tone={
                      weeklyProfit.cashProfit >= 0 ? "positive" : "negative"
                    }
                    signed
                  />
                  <MoneyFlowMetric
                    label="Tracked costs"
                    hint="Salary + tools + expenses"
                    value={trackedCosts}
                    tone="negative"
                    prefix="−"
                  />
                  <MoneyFlowMetric
                    label="Net result"
                    hint="What remains"
                    value={weeklyProfit.netProfit}
                    tone={weeklyProfit.netProfit >= 0 ? "positive" : "negative"}
                    signed
                    emphasized
                  />
                </div>
                <p className="text-center text-xs font-medium text-muted-foreground">
                  Cash P&amp;L − tracked costs = net result
                </p>
              </div>
            </div>

            <div className="grid gap-2 border-t pt-4 sm:grid-cols-3">
              <CostBreakdownItem
                href="/salaries"
                label="Salary accrual"
                value={weeklyProfit.salaryExpense}
              />
              <CostBreakdownItem
                href="/finances/subscriptions"
                label="Subscriptions"
                value={weeklyProfit.subscriptionExpense}
              />
              <CostBreakdownItem
                href="/finances/expenses"
                label="Logged expenses"
                value={weeklyProfit.oneTimeExpenses}
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Includes weekly salary accrual, one quarter of active monthly
              subscriptions, and expenses logged this week. Unlogged costs are
              not included.
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
              Cash P&amp;L · {caption}
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
            Before operating costs: deposits − withdrawals − change in user
            balances, inventory, and vouchers. Use the net-result card above for
            what the business actually made after tracked costs.
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

function MoneyFlowMetric({
  label,
  hint,
  value,
  tone,
  signed = false,
  prefix,
  emphasized = false,
}: {
  label: string;
  hint: string;
  value: number;
  tone: "positive" | "negative";
  signed?: boolean;
  prefix?: string;
  emphasized?: boolean;
}) {
  const sign = prefix ?? (signed ? (value >= 0 ? "+" : "−") : "");
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        emphasized
          ? "bg-foreground/[0.04] ring-1 ring-foreground/10"
          : "bg-card",
      )}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-lg font-bold tabular-nums",
          tone === "positive"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        {sign}
        {formatCurrency(Math.abs(value))}
      </p>
      <p className="mt-1 truncate text-[10px] text-muted-foreground">{hint}</p>
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
      className="group flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5 transition-colors hover:bg-muted/50"
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
      <p className="mt-1 truncate text-sm font-semibold tabular-nums">
        {value}
      </p>
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
