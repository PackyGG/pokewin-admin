"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { adminDrizzle } from "@/lib/admin-db";
import { expenses, recurring_expenses } from "@/lib/db-schema/admin/schema";
import { requireMotha } from "@/lib/salary/motha-gate";

const trimmedText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is too long`);

const amountSchema = z
  .number()
  .finite()
  .positive("Amount must be greater than zero")
  .max(100_000_000, "Amount is too large");

const expenseSchema = z.object({
  description: trimmedText("Description", 200),
  amount: amountSchema,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    }, "Enter a valid date"),
  paidTo: trimmedText("Paid to", 160),
  paidBy: z.string().trim().max(160).optional(),
  paymentMethod: trimmedText("Payment method", 50),
  category: trimmedText("Category", 80),
  notes: z.string().trim().max(2_000, "Notes are too long").optional(),
});

const subscriptionSchema = z.object({
  name: trimmedText("Name", 160),
  amount: amountSchema,
  category: trimmedText("Category", 80),
  notes: z.string().trim().max(2_000, "Notes are too long").optional(),
});

const idSchema = z.string().uuid("Invalid record id");

export type ExpenseInput = z.infer<typeof expenseSchema>;
export type SubscriptionInput = z.infer<typeof subscriptionSchema>;
export type FinanceActionResult =
  { success: true; id?: string } | { success: false; error: string };

function validationError(error: z.ZodError): FinanceActionResult {
  return { success: false, error: error.issues[0]?.message ?? "Invalid input" };
}

function refreshFinancePages() {
  revalidatePath("/finances");
  revalidatePath("/finances/expenses");
  revalidatePath("/finances/subscriptions");
}

export async function createExpense(
  data: ExpenseInput,
): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsed = expenseSchema.safeParse(data);
  if (!parsed.success) return validationError(parsed.error);

  const [created] = await adminDrizzle
    .insert(expenses)
    .values({
      description: parsed.data.description,
      amount: String(parsed.data.amount),
      date: parsed.data.date,
      paid_to: parsed.data.paidTo,
      paid_by: parsed.data.paidBy || null,
      payment_method: parsed.data.paymentMethod,
      category: parsed.data.category,
      notes: parsed.data.notes || null,
      created_by_id: session.userId,
      updated_at: new Date().toISOString(),
    })
    .returning({ id: expenses.id });
  if (!created) throw new Error("Expense insert returned no row");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_created",
    metadata: {
      expenseId: created.id,
      amount: parsed.data.amount,
      description: parsed.data.description,
    },
  });
  refreshFinancePages();
  return { success: true, id: created.id };
}

export async function updateExpense(
  id: string,
  data: ExpenseInput,
): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsedId = idSchema.safeParse(id);
  const parsed = expenseSchema.safeParse(data);
  if (!parsedId.success) return validationError(parsedId.error);
  if (!parsed.success) return validationError(parsed.error);

  const [updated] = await adminDrizzle
    .update(expenses)
    .set({
      description: parsed.data.description,
      amount: String(parsed.data.amount),
      date: parsed.data.date,
      paid_to: parsed.data.paidTo,
      paid_by: parsed.data.paidBy || null,
      payment_method: parsed.data.paymentMethod,
      category: parsed.data.category,
      notes: parsed.data.notes || null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(expenses.id, parsedId.data))
    .returning({ id: expenses.id });
  if (!updated) return { success: false, error: "Expense no longer exists" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_updated",
    metadata: { expenseId: parsedId.data, amount: parsed.data.amount },
  });
  refreshFinancePages();
  return { success: true };
}

export async function deleteExpense(id: string): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return validationError(parsed.error);

  const [deleted] = await adminDrizzle
    .delete(expenses)
    .where(eq(expenses.id, parsed.data))
    .returning({ id: expenses.id });
  if (!deleted) return { success: false, error: "Expense no longer exists" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_deleted",
    metadata: { expenseId: parsed.data },
  });
  refreshFinancePages();
  return { success: true };
}

export async function createSubscription(
  data: SubscriptionInput,
): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsed = subscriptionSchema.safeParse(data);
  if (!parsed.success) return validationError(parsed.error);

  const [created] = await adminDrizzle
    .insert(recurring_expenses)
    .values({
      name: parsed.data.name,
      amount: String(parsed.data.amount),
      category: parsed.data.category,
      notes: parsed.data.notes || null,
      is_active: true,
      created_by_id: session.userId,
      updated_at: new Date().toISOString(),
    })
    .returning({ id: recurring_expenses.id });
  if (!created) throw new Error("Subscription insert returned no row");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_created",
    metadata: {
      recurringExpenseId: created.id,
      name: parsed.data.name,
      amount: parsed.data.amount,
    },
  });
  refreshFinancePages();
  return { success: true, id: created.id };
}

export async function updateSubscription(
  id: string,
  data: SubscriptionInput,
): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsedId = idSchema.safeParse(id);
  const parsed = subscriptionSchema.safeParse(data);
  if (!parsedId.success) return validationError(parsedId.error);
  if (!parsed.success) return validationError(parsed.error);

  const [updated] = await adminDrizzle
    .update(recurring_expenses)
    .set({
      name: parsed.data.name,
      amount: String(parsed.data.amount),
      category: parsed.data.category,
      notes: parsed.data.notes || null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(recurring_expenses.id, parsedId.data))
    .returning({ id: recurring_expenses.id });
  if (!updated)
    return { success: false, error: "Subscription no longer exists" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_updated",
    metadata: { recurringExpenseId: parsedId.data, amount: parsed.data.amount },
  });
  refreshFinancePages();
  return { success: true };
}

export async function toggleSubscription(
  id: string,
  isActive: boolean,
): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsedId = idSchema.safeParse(id);
  const parsedActive = z.boolean().safeParse(isActive);
  if (!parsedId.success) return validationError(parsedId.error);
  if (!parsedActive.success) return validationError(parsedActive.error);

  const [updated] = await adminDrizzle
    .update(recurring_expenses)
    .set({ is_active: parsedActive.data, updated_at: new Date().toISOString() })
    .where(eq(recurring_expenses.id, parsedId.data))
    .returning({ id: recurring_expenses.id });
  if (!updated)
    return { success: false, error: "Subscription no longer exists" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_toggled",
    metadata: {
      recurringExpenseId: parsedId.data,
      isActive: parsedActive.data,
    },
  });
  refreshFinancePages();
  return { success: true };
}

export async function deleteSubscription(
  id: string,
): Promise<FinanceActionResult> {
  const session = await requireMotha();
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return validationError(parsed.error);

  const [deleted] = await adminDrizzle
    .delete(recurring_expenses)
    .where(eq(recurring_expenses.id, parsed.data))
    .returning({ id: recurring_expenses.id });
  if (!deleted)
    return { success: false, error: "Subscription no longer exists" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_deleted",
    metadata: { recurringExpenseId: parsed.data },
  });
  refreshFinancePages();
  return { success: true };
}
