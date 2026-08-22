import "server-only";

import { and, eq, gte, lte, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  expenses,
  recurring_expenses,
  salary_employees,
} from "@/lib/db-schema/admin/schema";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { financePeriodSince, type FinancePeriod } from "@/lib/finances/periods";
import { getWindowMetrics } from "@/lib/metrics/queries";
import {
  calculateWindowedPnlOneShot,
  getDailyPnl,
  type DailyPnlPoint,
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

export type OperatingExpenseSummary = {
  monthlySubscriptions: number;
  subscriptionExpense: number;
  oneTimeExpenses: number;
  oneTimeByDate: Array<{ date: string; amount: number }>;
};

const HOUR_MS = 60 * 60 * 1_000;

function selectedPeriodHours(period: FinancePeriod, now: Date): number {
  return Math.max(
    0,
    (now.getTime() - financePeriodSince(period, now).getTime()) / HOUR_MS,
  );
}

/** Active salary commitments, including the run rate for the selected window. */
export async function getSalaryExpenseSummary(
  period: FinancePeriod,
  now: Date = new Date(),
): Promise<SalaryExpenseSummary> {
  const [row] = await adminDrizzle
    .select({
      activeEmployees: sql<number>`COUNT(*)::int`,
      monthly: sql<string>`COALESCE(SUM(${salary_employees.salary_usdt}), 0)::text`,
    })
    .from(salary_employees)
    .where(eq(salary_employees.active, true));

  const monthly = toNumber(row?.monthly);
  const hours = selectedPeriodHours(period, now);
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
export async function getOperatingExpenseSummary(
  period: FinancePeriod,
  now: Date = new Date(),
): Promise<OperatingExpenseSummary> {
  const since = financePeriodSince(period, now);
  const startDate = since.toISOString().slice(0, 10);
  const throughDate = now.toISOString().slice(0, 10);
  const [expenseRows, subscriptionRows] = await Promise.all([
    adminDrizzle
      .select({
        date: expenses.date,
        total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::text`,
      })
      .from(expenses)
      .where(
        and(gte(expenses.date, startDate), lte(expenses.date, throughDate)),
      )
      .groupBy(expenses.date),
    adminDrizzle
      .select({
        total: sql<string>`COALESCE(SUM(${recurring_expenses.amount}) FILTER (WHERE ${recurring_expenses.is_active}), 0)::text`,
      })
      .from(recurring_expenses),
  ]);

  const monthlySubscriptions = toNumber(subscriptionRows[0]?.total);
  const oneTimeByDate = expenseRows
    .map((row) => ({ date: row.date, amount: toNumber(row.total) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    monthlySubscriptions,
    subscriptionExpense:
      monthlySubscriptions * (selectedPeriodHours(period, now) / (30 * 24)),
    oneTimeExpenses: oneTimeByDate.reduce((sum, row) => sum + row.amount, 0),
    oneTimeByDate,
  };
}

export type FinanceGamingSummary = {
  wager: number;
  gamingPayout: number;
  ggr: number;
};

/** Canonical wager and GGR used by the finance revenue-to-profit bridge. */
export async function getFinanceGamingSummary(
  period: FinancePeriod,
  now: Date = new Date(),
): Promise<FinanceGamingSummary> {
  const metrics = await getWindowMetrics({
    window: { since: financePeriodSince(period, now) },
  });
  return {
    wager: metrics.wager,
    gamingPayout: metrics.gamingPayout,
    ggr: metrics.ggr,
  };
}

/** Daily canonical balance-sheet P&L, trimmed to the selected finance window. */
export async function getFinanceDailyPnl(
  period: FinancePeriod,
  now: Date = new Date(),
): Promise<DailyPnlPoint[]> {
  const days = period === "7d" ? 7 : 30;
  const sinceDate = financePeriodSince(period, now).toISOString().slice(0, 10);
  return (await getDailyPnl(days)).filter((point) => point.date >= sinceDate);
}
