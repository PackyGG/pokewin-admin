import Link from "next/link";
import { Coins, Wallet } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { isMotha } from "@/lib/salary/motha-gate";
import {
  getExpenses,
  getRecurringExpenses,
  getSpendingSummary,
  getMonthlyTrend,
} from "@/lib/queries/spending";
import { SummaryCards } from "./summary-cards";
import { SpendingTabs } from "./tab-content";
import { DateRangeFilter } from "./date-range-filter";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Spending" };

function getDefaultRange() {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/spending");
  const params = await searchParams;

  const defaults = getDefaultRange();
  const from = params.from || defaults.from;
  const to = params.to || defaults.to;

  const [expenses, recurring, summary, trend, mothaAccess] = await Promise.all([
    getExpenses({ page: 1, perPage: 500, from, to }),
    getRecurringExpenses(),
    getSpendingSummary(from, to),
    getMonthlyTrend(6),
    // Salaries entry-point only renders for the dedicated user. Other
    // admins / support / etc. don't see the link at all.
    isMotha(session.userId),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Wallet className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">
                Spending Sheet
              </h1>
              <p className="text-sm text-muted-foreground">
                Track operational expenses, recurring costs, and month-over-month trends.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {mothaAccess && (
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link href="/spending/salaries">
                    <Coins className="size-4" />
                    Employee Salaries
                  </Link>
                }
              />
            )}
            <DateRangeFilter from={from} to={to} />
          </div>
        </div>
      </PageHero>

      <SummaryCards summary={summary} from={from} to={to} trend={trend} />

      <FadeIn>
        <SpendingTabs
          defaultTab={params.tab === "recurring" ? "recurring" : "expenses"}
          expensesData={expenses.data}
          recurringData={recurring}
        />
      </FadeIn>
    </div>
  );
}
