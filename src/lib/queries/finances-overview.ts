import "server-only";

import { eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { salary_employees } from "@/lib/db-schema/admin/schema";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  FINANCE_PERIODS,
  type FinancePeriod,
} from "@/lib/finances/periods";
import {
  calculateWindowedPnlOneShot,
  type WindowedPnl,
} from "@/lib/queries/pnl";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Canonical rolling balance-sheet P&L for the selected finance window.
 * The one-shot variant keeps the read to one production-mirror pool slot.
 */
export async function getFinanceProfit(
  period: FinancePeriod,
  now: Date = new Date(),
): Promise<WindowedPnl> {
  const definition = FINANCE_PERIODS.find((item) => item.value === period);
  const hours = definition?.hours ?? 24;
  const since = new Date(now.getTime() - hours * 60 * 60 * 1_000);
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
