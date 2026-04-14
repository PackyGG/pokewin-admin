import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import { formatMonthYear } from "@/lib/utils/format";
import type { PaginatedResult } from "@/lib/types";

export type ExpenseListItem = {
  id: string;
  description: string;
  amount: number;
  date: string;
  paidTo: string;
  paidBy: string | null;
  paymentMethod: string;
  category: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
};

export type RecurringExpenseListItem = {
  id: string;
  name: string;
  amount: number;
  category: string;
  notes: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
};

export type SpendingSummary = {
  totalPeriod: number;
  totalPrevPeriod: number;
  recurringTotal: number;
  byCategory: { category: string; amount: number }[];
};

export type MonthlyTrendItem = {
  month: string; // "2026-03"
  label: string; // "Mar 2026"
  total: number;
};

export async function getExpenses(params: {
  page?: number;
  perPage?: number;
  search?: string;
  category?: string;
  from?: string; // "2026-03-01"
  to?: string;   // "2026-03-31"
}): Promise<PaginatedResult<ExpenseListItem>> {
  const {
    page = 1,
    perPage = 25,
    search,
    category,
    from,
    to,
  } = params;

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { description: { contains: search, mode: "insensitive" } },
      { paid_to: { contains: search, mode: "insensitive" } },
    ];
  }

  if (category) {
    where.category = category;
  }

  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) {
      // Include the end date fully (end of day)
      const endDate = new Date(to);
      endDate.setDate(endDate.getDate() + 1);
      dateFilter.lt = endDate;
    }
    where.date = dateFilter;
  }

  const [expenses, total] = await Promise.all([
    adminDb.expenses.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { created_by: { select: { username: true } } },
    }),
    adminDb.expenses.count({ where }),
  ]);

  return {
    data: expenses.map((e) => ({
      id: e.id,
      description: e.description,
      amount: toNumber(e.amount),
      date: e.date.toISOString().split("T")[0],
      paidTo: e.paid_to,
      paidBy: e.paid_by,
      paymentMethod: e.payment_method,
      category: e.category,
      notes: e.notes,
      createdBy: e.created_by.username,
      createdAt: e.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getRecurringExpenses(): Promise<RecurringExpenseListItem[]> {
  const items = await adminDb.recurring_expenses.findMany({
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: { created_by: { select: { username: true } } },
  });

  return items.map((r) => ({
    id: r.id,
    name: r.name,
    amount: toNumber(r.amount),
    category: r.category,
    notes: r.notes,
    isActive: r.is_active,
    createdBy: r.created_by.username,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getUniqueCategories(): Promise<string[]> {
  const [expenseCats, recurringCats] = await Promise.all([
    adminDb.expenses.findMany({
      select: { category: true },
      distinct: ["category"],
    }),
    adminDb.recurring_expenses.findMany({
      select: { category: true },
      distinct: ["category"],
    }),
  ]);

  const all = new Set([
    ...expenseCats.map((e) => e.category),
    ...recurringCats.map((r) => r.category),
  ]);
  return [...all].sort();
}

export async function getSpendingSummary(
  from: string,
  to: string
): Promise<SpendingSummary> {
  const startDate = new Date(from);
  const endDate = new Date(to);
  endDate.setDate(endDate.getDate() + 1);

  // Calculate previous period of same length for comparison
  const periodMs = endDate.getTime() - startDate.getTime();
  const prevEndDate = new Date(startDate);
  const prevStartDate = new Date(prevEndDate.getTime() - periodMs);

  const [periodAgg, prevPeriodAgg, byCategoryAgg, recurringAgg] =
    await Promise.all([
      adminDb.expenses.aggregate({
        _sum: { amount: true },
        where: { date: { gte: startDate, lt: endDate } },
      }),
      adminDb.expenses.aggregate({
        _sum: { amount: true },
        where: { date: { gte: prevStartDate, lt: prevEndDate } },
      }),
      adminDb.expenses.groupBy({
        by: ["category"],
        _sum: { amount: true },
        where: { date: { gte: startDate, lt: endDate } },
      }),
      adminDb.recurring_expenses.aggregate({
        _sum: { amount: true },
        where: { is_active: true },
      }),
    ]);

  return {
    totalPeriod: toNumber(periodAgg._sum.amount),
    totalPrevPeriod: toNumber(prevPeriodAgg._sum.amount),
    recurringTotal: toNumber(recurringAgg._sum.amount),
    byCategory: byCategoryAgg.map((g) => ({
      category: g.category,
      amount: toNumber(g._sum.amount),
    })),
  };
}

export async function getMonthlyTrend(months: number = 6): Promise<MonthlyTrendItem[]> {
  const now = new Date();
  const results: MonthlyTrendItem[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    const endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);

    const [expenseAgg, recurringAgg] = await Promise.all([
      adminDb.expenses.aggregate({
        _sum: { amount: true },
        where: { date: { gte: startDate, lt: endDate } },
      }),
      adminDb.recurring_expenses.aggregate({
        _sum: { amount: true },
        where: { is_active: true },
      }),
    ]);

    const label = formatMonthYear(d);
    const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    results.push({
      month: monthStr,
      label,
      total: toNumber(expenseAgg._sum.amount) + toNumber(recurringAgg._sum.amount),
    });
  }

  return results;
}
