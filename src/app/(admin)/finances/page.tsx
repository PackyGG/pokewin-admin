import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowRight,
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
import { REWARD_QUERY_TIMEOUT_MS, safeQuery } from "@/lib/errors/safe-query";
import {
  FINANCE_PERIODS,
  financePeriodLabel,
  parseFinancePeriod,
  type FinancePeriod,
} from "@/lib/finances/periods";
import { houseAmountTextClass } from "@/lib/house-pov";
import {
  getFinanceProfit,
  getSalaryExpenseSummary,
} from "@/lib/queries/finances-overview";
import { requireMotha } from "@/lib/salary/motha-gate";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

import { FinancesOverviewSkeleton } from "./skeleton";

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

      <Suspense key={period} fallback={<FinancesOverviewSkeleton />}>
        <FinancesOverview period={period} />
      </Suspense>
    </div>
  );
}

async function FinancesOverview({ period }: { period: FinancePeriod }) {
  const [profitResult, salaryResult] = await Promise.all([
    safeQuery(
      () => getFinanceProfit(period),
      null,
      `finances.profit.${period}`,
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getSalaryExpenseSummary(period),
      null,
      `finances.salaryExpenses.${period}`,
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const profit = profitResult.data;
  const salaries = salaryResult.data;
  const label = financePeriodLabel(period);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="min-h-[310px]">
        <CardHeader className="gap-3 border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                {profit && profit.pnl < 0 ? (
                  <TrendingDown className="size-4 text-rose-500" aria-hidden />
                ) : (
                  <TrendingUp className="size-4 text-emerald-500" aria-hidden />
                )}
                Profit
              </CardTitle>
              <CardDescription>Rolling balance-sheet P&amp;L</CardDescription>
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

        <CardContent className="flex flex-1 flex-col justify-between gap-5">
          {profit ? (
            <>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Last {label}
                </p>
                <p
                  className={cn(
                    "mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl",
                    houseAmountTextClass(profit.pnl),
                  )}
                >
                  {profit.pnl >= 0 ? "+" : "−"}
                  <AnimatedNumber
                    value={Math.abs(profit.pnl)}
                    format="currency"
                  />
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <ProfitDetail label="Deposits" value={profit.deposits} tone="positive" />
                <ProfitDetail label="Withdrawals" value={profit.withdrawals} tone="negative" />
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
      </Card>

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
                  Last {label}
                </p>
                <p className="mt-1 text-4xl font-bold tracking-tight text-rose-600 tabular-nums dark:text-rose-400 sm:text-5xl">
                  −<AnimatedNumber value={salaries.periodExpense} format="currency" />
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
    </div>
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
