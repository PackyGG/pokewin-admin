import { requirePageAccess } from "@/lib/dal";
import { getExpenses, getRecurringExpenses, getSpendingSummary, getMonthlyTrend } from "@/lib/queries/spending";
import { SummaryCards } from "./summary-cards";
import { SpendingTabs } from "./tab-content";
import { DateRangeFilter } from "./date-range-filter";

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
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Spending Sheet</h1>
        <DateRangeFilter from={from} to={to} />
      </div>

      <SummaryCards summary={summary} from={from} to={to} trend={trend} />

      <SpendingTabs
        defaultTab={params.tab === "recurring" ? "recurring" : "expenses"}
        expensesData={expenses.data}
        recurringData={recurring}
      />
    </div>
  );
}
