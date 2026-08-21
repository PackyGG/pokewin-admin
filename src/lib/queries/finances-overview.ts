import "server-only";

import { and, eq, gte, lte, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  expenses,
  recurring_expenses,
  salary_employees,
} from "@/lib/db-schema/admin/schema";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  FINANCE_PERIODS,
  financePeriodSince,
  type FinancePeriod,
} from "@/lib/finances/periods";
import {
  calculateWindowedPnlOneShot,
  type WindowedPnl,
} from "@/lib/queries/pnl";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Canonical balance-sheet P&L for the selected finance window. The 7d option
 * starts at Monday 00:00 UTC; the other options remain rolling windows.
 * The one-shot variant keeps the read to one production-mirror pool slot.
 */
export async function getFinanceProfit(
  period: FinancePeriod,
  now: Date = new Date(),
): Promise<WindowedPnl> {
  const since = financePeriodSince(period, now);
  const excludedUserIds = await getExcludedUserIds();

  return calculateWindowedPnlOneShot({
    since,
    excludeUserIds: excludedUserIds,
  });
}

export type SalaryExpenseSummary = {
  activeEmployees: number;
  periodExpense: number;
  monthly: number;
  annual: number;
};

export type WeeklyOperatingExpenseSummary = {
  monthlySubscriptions: number;
  oneTimeExpenses: number;
};

/** Active salary commitments, including the run rate for the selected window. */
export async function getSalaryExpenseSummary(
  period: FinancePeriod,
): Promise<SalaryExpenseSummary> {
  const [row] = await adminDrizzle
    .select({
      activeEmployees: sql<number>`COUNT(*)::int`,
      monthly: sql<string>`COALESCE(SUM(${salary_employees.salary_usdt}), 0)::text`,
    })
    .from(salary_employees)
    .where(eq(salary_employees.active, true));

  const monthly = toNumber(row?.monthly);
  const definition = FINANCE_PERIODS.find((item) => item.value === period);
  const hours = definition?.hours ?? 24;
  return {
    activeEmployees: Number(row?.activeEmployees ?? 0),
    // Salary records are monthly commitments. A 30-day operating month keeps
    // the finance chips intuitive: 24h is 1/30, 3d is 1/10, and 30d is the
    // full monthly commitment.
    periodExpense: monthly * (hours / (30 * 24)),
    monthly,
    annual: monthly * 12,
  };
}

/** Admin-owned overhead used to turn weekly cash profit into net P&L. */
export async function getWeeklyOperatingExpenseSummary(
  now: Date = new Date(),
): Promise<WeeklyOperatingExpenseSummary> {
  const since = financePeriodSince("7d", now);
  const startDate = since.toISOString().slice(0, 10);
  const throughDate = now.toISOString().slice(0, 10);
  const [expenseRows, subscriptionRows] = await Promise.all([
    adminDrizzle
      .select({
        total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::text`,
      })
      .from(expenses)
      .where(and(gte(expenses.date, startDate), lte(expenses.date, throughDate))),
    adminDrizzle
      .select({
        total: sql<string>`COALESCE(SUM(${recurring_expenses.amount}) FILTER (WHERE ${recurring_expenses.is_active}), 0)::text`,
      })
      .from(recurring_expenses),
  ]);

  return {
    monthlySubscriptions: toNumber(subscriptionRows[0]?.total),
    oneTimeExpenses: toNumber(expenseRows[0]?.total),
  };
}
