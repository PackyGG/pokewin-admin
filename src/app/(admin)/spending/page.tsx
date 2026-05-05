import { Wallet } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
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
  await requirePageAccess("/spending");
  const params = await searchParams;

  const defaults = getDefaultRange();
  const from = params.from || defaults.from;
  const to = params.to || defaults.to;

  const [expenses, recurring, summary, trend] = await Promise.all([
    getExpenses({ page: 1, perPage: 500, from, to }),
    getRecurringExpenses(),
    getSpendingSummary(from, to),
    getMonthlyTrend(6),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        {/* Identity + date-range filter stack on phones — the filter
            includes 2 date pickers + 5 preset chips and won't fit
            beside the title at 360px. At md+ they go side-by-side
            with the original layout. */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Wallet className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight sm:text-2xl">
                Spending Sheet
              </h1>
              <p className="text-xs text-muted-foreground sm:text-sm">
                Track operational expenses, recurring costs, and month-over-month trends.
              </p>
            </div>
          </div>
          <DateRangeFilter from={from} to={to} />
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
