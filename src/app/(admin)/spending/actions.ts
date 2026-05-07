"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

const expenseSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  date: z.string().min(1),
  paidTo: z.string().min(1),
  paidBy: z.string().optional(),
  paymentMethod: z.string().min(1),
  category: z.string().min(1),
  notes: z.string().optional(),
});

const recurringSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
  category: z.string().min(1),
  notes: z.string().optional(),
});

export async function createExpense(data: {
  description: string;
  amount: number;
  date: string;
  paidTo: string;
  paidBy?: string;
  paymentMethod: string;
  category: string;
  notes?: string;
}) {
  const session = await requirePageAccess("/spending");
  const parsed = expenseSchema.parse(data);
  await requireCapability(session, "__can_create_expense", "create expenses");

  // Explicit select — Prisma's default RETURNING * references every column
  // the generated client knows about. If a new column is missing on prod,
  // the insert crashes with P2022 even though the write columns are valid.
  const expense = await adminDb.expenses.create({
    data: {
      description: parsed.description,
      amount: parsed.amount,
      date: new Date(parsed.date),
      paid_to: parsed.paidTo,
      paid_by: parsed.paidBy || null,
      payment_method: parsed.paymentMethod,
      category: parsed.category,
      notes: parsed.notes || null,
      created_by_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_created",
    metadata: { expenseId: expense.id, amount: parsed.amount, description: parsed.description },
  });

  revalidatePath("/spending");
}

export async function updateExpense(
  id: string,
  data: {
    description: string;
    amount: number;
    date: string;
    paidTo: string;
    paymentMethod: string;
    category: string;
    notes?: string;
  }
) {
  const session = await requirePageAccess("/spending");
  const parsed = expenseSchema.parse(data);
  await requireCapability(session, "__can_update_expense", "update expenses");

  await adminDb.expenses.update({
    where: { id },
    data: {
      description: parsed.description,
      amount: parsed.amount,
      date: new Date(parsed.date),
      paid_to: parsed.paidTo,
      paid_by: parsed.paidBy || null,
      payment_method: parsed.paymentMethod,
      category: parsed.category,
      notes: parsed.notes || null,
      updated_at: new Date(),
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_updated",
    metadata: { expenseId: id, amount: parsed.amount },
  });

  revalidatePath("/spending");
}

export async function deleteExpense(id: string) {
  const session = await requirePageAccess("/spending");
  await requireCapability(session, "__can_delete_expense", "delete expenses");

  await adminDb.expenses.delete({ where: { id }, select: { id: true } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_deleted",
    metadata: { expenseId: id },
  });

  revalidatePath("/spending");
}

export async function createRecurringExpense(data: {
  name: string;
  amount: number;
  category: string;
  notes?: string;
}) {
  const session = await requirePageAccess("/spending");
  const parsed = recurringSchema.parse(data);
  await requireCapability(session, "__can_create_recurring_expense", "create recurring expenses");

  const item = await adminDb.recurring_expenses.create({
    data: {
      name: parsed.name,
      amount: parsed.amount,
      category: parsed.category,
      notes: parsed.notes || null,
      created_by_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_created",
    metadata: { recurringExpenseId: item.id, name: parsed.name, amount: parsed.amount },
  });

  revalidatePath("/spending");
}

export async function updateRecurringExpense(
  id: string,
  data: {
    name: string;
    amount: number;
    category: string;
    notes?: string;
  }
) {
  const session = await requirePageAccess("/spending");
  const parsed = recurringSchema.parse(data);
  await requireCapability(session, "__can_update_recurring_expense", "update recurring expenses");

  await adminDb.recurring_expenses.update({
    where: { id },
    data: {
      name: parsed.name,
      amount: parsed.amount,
      category: parsed.category,
      notes: parsed.notes || null,
      updated_at: new Date(),
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_updated",
    metadata: { recurringExpenseId: id },
  });

  revalidatePath("/spending");
}

export async function toggleRecurringExpense(id: string, isActive: boolean) {
  const session = await requirePageAccess("/spending");
  await requireCapability(session, "__can_toggle_recurring_expense", "toggle recurring expenses");

  await adminDb.recurring_expenses.update({
    where: { id },
    data: { is_active: isActive, updated_at: new Date() },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_toggled",
    metadata: { recurringExpenseId: id, isActive },
  });

  revalidatePath("/spending");
}

// --- Partial field update actions for inline editing ---

// Single source of truth for which fields are inline-editable. The
// type-level `z.enum(...)` makes TS catch drift at compile time so a
// field added to the form (or removed from the validator map below)
// can't slip through silently.
const EXPENSE_FIELD_KEY = z.enum([
  "description",
  "amount",
  "date",
  "paidTo",
  "paidBy",
  "paymentMethod",
  "category",
  "notes",
]);
type ExpenseFieldKey = z.infer<typeof EXPENSE_FIELD_KEY>;

const EXPENSE_FIELD_MAP: Record<ExpenseFieldKey, string> = {
  description: "description",
  amount: "amount",
  date: "date",
  paidTo: "paid_to",
  paidBy: "paid_by",
  paymentMethod: "payment_method",
  category: "category",
  notes: "notes",
};

const expenseFieldValidators: Record<ExpenseFieldKey, z.ZodType> = {
  description: z.string().min(1).nullable(),
  amount: z.number().positive().nullable(),
  date: z.string().min(1).nullable(),
  paidTo: z.string().min(1).nullable(),
  paidBy: z.string().nullable(),
  paymentMethod: z.string().min(1).nullable(),
  category: z.string().min(1).nullable(),
  notes: z.string().nullable(),
};

export async function updateExpenseField(
  id: string,
  field: string,
  value: string | number | null
) {
  const session = await requirePageAccess("/spending");

  // Validate the field key against the allowlist BEFORE the value
  // validator runs. The previous version skipped value validation
  // silently when `field` wasn't in the map — a typo on the client
  // would write whatever value came in.
  const parsedField = EXPENSE_FIELD_KEY.safeParse(field);
  if (!parsedField.success) {
    throw new Error("Field cannot be edited inline");
  }
  const fieldKey = parsedField.data;

  expenseFieldValidators[fieldKey].parse(value);

  const dbField = EXPENSE_FIELD_MAP[fieldKey];

  const dbValue =
    fieldKey === "date" && typeof value === "string"
      ? new Date(value)
      : value;

  await adminDb.expenses.update({
    where: { id },
    data: { [dbField]: dbValue, updated_at: new Date() },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "expense_field_updated",
    metadata: { expenseId: id, field: fieldKey, value },
  });

  revalidatePath("/spending");
}

const RECURRING_FIELD_KEY = z.enum([
  "name",
  "amount",
  "category",
  "notes",
  "isActive",
]);
type RecurringFieldKey = z.infer<typeof RECURRING_FIELD_KEY>;

const RECURRING_FIELD_MAP: Record<RecurringFieldKey, string> = {
  name: "name",
  amount: "amount",
  category: "category",
  notes: "notes",
  isActive: "is_active",
};

const recurringFieldValidators: Record<RecurringFieldKey, z.ZodType> = {
  name: z.string().min(1),
  amount: z.number().positive(),
  category: z.string().min(1),
  notes: z.string().nullable(),
  isActive: z.boolean(),
};

export async function updateRecurringExpenseField(
  id: string,
  field: string,
  value: string | number | boolean | null
) {
  const session = await requirePageAccess("/spending");

  const parsedField = RECURRING_FIELD_KEY.safeParse(field);
  if (!parsedField.success) {
    throw new Error("Field cannot be edited inline");
  }
  const fieldKey = parsedField.data;

  recurringFieldValidators[fieldKey].parse(value);

  const dbField = RECURRING_FIELD_MAP[fieldKey];

  await adminDb.recurring_expenses.update({
    where: { id },
    data: { [dbField]: value, updated_at: new Date() },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_field_updated",
    metadata: { recurringExpenseId: id, field: fieldKey, value },
  });

  revalidatePath("/spending");
}

export async function deleteRecurringExpense(id: string) {
  const session = await requirePageAccess("/spending");
  await requireCapability(session, "__can_delete_recurring_expense", "delete recurring expenses");

  await adminDb.recurring_expenses.delete({ where: { id }, select: { id: true } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "recurring_expense_deleted",
    metadata: { recurringExpenseId: id },
  });

  revalidatePath("/spending");
}
