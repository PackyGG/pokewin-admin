import { desc, eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_users,
  expenses,
  recurring_expenses,
} from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";

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
};

export type SubscriptionListItem = {
  id: string;
  name: string;
  amount: number;
  isActive: boolean;
  createdBy: string;
};

export type ExpensePageData = {
  items: ExpenseListItem[];
  summary: {
    total: number;
    thisMonth: number;
    count: number;
    topCategory: string | null;
  };
};

export type SubscriptionPageData = {
  items: SubscriptionListItem[];
  summary: {
    activeMonthly: number;
    annualRunRate: number;
    activeCount: number;
    inactiveCount: number;
  };
};

function currentMonthStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function getExpensePageData(): Promise<ExpensePageData> {
  const monthStart = currentMonthStart();
  const [rows, aggregateRows, categoryRows] = await Promise.all([
    adminDrizzle
      .select({
        id: expenses.id,
        description: expenses.description,
        amount: expenses.amount,
        date: expenses.date,
        paidTo: expenses.paid_to,
        paidBy: expenses.paid_by,
        paymentMethod: expenses.payment_method,
        category: expenses.category,
        notes: expenses.notes,
        createdBy: admin_users.username,
      })
      .from(expenses)
      .leftJoin(admin_users, eq(expenses.created_by_id, admin_users.id))
      .orderBy(desc(expenses.date), desc(expenses.created_at))
      .limit(500),
    adminDrizzle
      .select({
        total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::text`,
        thisMonth: sql<string>`COALESCE(SUM(${expenses.amount}) FILTER (WHERE ${expenses.date} >= ${monthStart}::date), 0)::text`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(expenses),
    adminDrizzle
      .select({
        category: expenses.category,
        total: sql<string>`COALESCE(SUM(${expenses.amount}), 0)::text`,
      })
      .from(expenses)
      .groupBy(expenses.category)
      .orderBy(desc(sql`SUM(${expenses.amount})`))
      .limit(1),
  ]);

  const aggregate = aggregateRows[0];
  return {
    items: rows.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      createdBy: row.createdBy ?? "Former admin",
    })),
    summary: {
      total: toNumber(aggregate?.total),
      thisMonth: toNumber(aggregate?.thisMonth),
      count: Number(aggregate?.count ?? 0),
      topCategory: categoryRows[0]?.category ?? null,
    },
  };
}

export async function getSubscriptionPageData(): Promise<SubscriptionPageData> {
  const [rows, aggregateRows] = await Promise.all([
    adminDrizzle
      .select({
        id: recurring_expenses.id,
        name: recurring_expenses.name,
        amount: recurring_expenses.amount,
        isActive: recurring_expenses.is_active,
        createdBy: admin_users.username,
      })
      .from(recurring_expenses)
      .leftJoin(
        admin_users,
        eq(recurring_expenses.created_by_id, admin_users.id),
      )
      .orderBy(desc(recurring_expenses.is_active), recurring_expenses.name),
    adminDrizzle
      .select({
        activeMonthly: sql<string>`COALESCE(SUM(${recurring_expenses.amount}) FILTER (WHERE ${recurring_expenses.is_active}), 0)::text`,
        activeCount: sql<number>`COUNT(*) FILTER (WHERE ${recurring_expenses.is_active})::int`,
        inactiveCount: sql<number>`COUNT(*) FILTER (WHERE NOT ${recurring_expenses.is_active})::int`,
      })
      .from(recurring_expenses),
  ]);

  const aggregate = aggregateRows[0];
  const activeMonthly = toNumber(aggregate?.activeMonthly);
  return {
    items: rows.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      createdBy: row.createdBy ?? "Former admin",
    })),
    summary: {
      activeMonthly,
      annualRunRate: activeMonthly * 12,
      activeCount: Number(aggregate?.activeCount ?? 0),
      inactiveCount: Number(aggregate?.inactiveCount ?? 0),
    },
  };
}
