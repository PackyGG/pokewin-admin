"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { salary_employees, salary_payments, salary_payouts } from "@/lib/db-schema/admin/schema";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { logError } from "@/lib/errors/logger";
import { requireMotha } from "@/lib/salary/motha-gate";
import { isAddress, normalizeAddress } from "@/lib/salary/wallet";

// ── Schemas ─────────────────────────────────────────────────────────

const CADENCES = ["weekly", "biweekly", "monthly"] as const;

const employeeSchema = z.object({
  discordName: z
    .string()
    .trim()
    .min(1, "Discord name is required")
    .max(80),
  ethAddress: z.string().trim().min(1, "Address is required"),
  cadence: z.enum(CADENCES).optional(),
  salaryUsdt: z
    .number()
    .finite()
    .positive("Salary must be > 0")
    .max(1_000_000),
  notes: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
  // Recurring pay day as a day of the month (1-31). null clears it.
  payDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
});

const updateEmployeeSchema = employeeSchema.partial().extend({
  id: z.string().uuid(),
});

// ── Employees ───────────────────────────────────────────────────────

export async function addSalaryEmployee(
  data: z.infer<typeof employeeSchema>,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requireMotha();
  const parsed = employeeSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const address = parsed.data.ethAddress.trim();
  if (!isAddress(address)) {
    return {
      success: false,
      error: "Invalid wallet address — use an ERC-20 (0x…) or Solana address",
    };
  }

  const [created] = await adminDrizzle.insert(salary_employees).values({
      discord_name: parsed.data.discordName,
      eth_address: normalizeAddress(address),
      cadence: parsed.data.cadence ?? "monthly",
      salary_usdt: String(parsed.data.salaryUsdt),
      max_per_payout: null,
      notes: parsed.data.notes?.trim() || null,
      active: parsed.data.active ?? true,
      pay_day_of_month: parsed.data.payDayOfMonth ?? null,
      created_by_id: session.userId,
      updated_at: new Date().toISOString(),
    }).returning({ id: salary_employees.id });
  if (!created) throw new Error("Salary employee insert returned no row");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_employee_added",
    metadata: {
      employeeId: created.id,
      discordName: parsed.data.discordName,
      ethAddress: normalizeAddress(address),
      cadence: parsed.data.cadence ?? "monthly",
      salaryUsdt: parsed.data.salaryUsdt,
    },
  });

  revalidatePath("/salaries");
  return { success: true, id: created.id };
}

export async function updateSalaryEmployee(
  data: z.infer<typeof updateEmployeeSchema>,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireMotha();
  const parsed = updateEmployeeSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const updateData: Partial<typeof salary_employees.$inferInsert> = {};
  if (parsed.data.discordName !== undefined)
    updateData.discord_name = parsed.data.discordName;
  if (parsed.data.ethAddress !== undefined) {
    if (!isAddress(parsed.data.ethAddress.trim())) {
      return {
        success: false,
        error: "Invalid wallet address — use an ERC-20 (0x…) or Solana address",
      };
    }
    updateData.eth_address = normalizeAddress(parsed.data.ethAddress);
  }
  if (parsed.data.cadence !== undefined) updateData.cadence = parsed.data.cadence;
  if (parsed.data.salaryUsdt !== undefined)
    updateData.salary_usdt = String(parsed.data.salaryUsdt);
  if (parsed.data.notes !== undefined) {
    updateData.notes = parsed.data.notes?.trim() || null;
  }
  if (parsed.data.active !== undefined) updateData.active = parsed.data.active;
  if (parsed.data.payDayOfMonth !== undefined)
    updateData.pay_day_of_month = parsed.data.payDayOfMonth;

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "Nothing to update" };
  }

  await adminDrizzle.update(salary_employees).set(updateData)
    .where(eq(salary_employees.id, parsed.data.id));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_employee_updated",
    metadata: { employeeId: parsed.data.id, fields: Object.keys(updateData) },
  });

  revalidatePath("/salaries");
  return { success: true };
}

export async function deleteSalaryEmployee(
  employeeId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireMotha();
  if (!z.string().uuid().safeParse(employeeId).success) {
    return { success: false, error: "Invalid id" };
  }
  // Refuse to delete if there are payouts on file — historical record
  // matters. Mark inactive instead.
  const [payout] = await adminDrizzle.select({ value: count() }).from(salary_payouts)
    .where(eq(salary_payouts.employee_id, employeeId));
  const payoutCount = payout?.value ?? 0;
  if (payoutCount > 0) {
    return {
      success: false,
      error: `Cannot delete — ${payoutCount} payout${payoutCount === 1 ? "" : "s"} on record. Deactivate instead.`,
    };
  }

  await adminDrizzle.delete(salary_employees).where(eq(salary_employees.id, employeeId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_employee_deleted",
    metadata: { employeeId },
  });

  revalidatePath("/salaries");
  return { success: true };
}

// ── Payment tracking ────────────────────────────────────────────────
// Lightweight: a saved payment link + date per employee. Distinct from
// the legacy salary_payouts table (kept, unused). Stored in
// salary_payments.

const paymentLinkSchema = z
  .string()
  .trim()
  .min(1, "Payment link is required")
  .max(2000, "Link is too long")
  .refine((v) => {
    // Only allow real http(s) links — blocks javascript:/data: etc. so
    // the rendered <a href> can't execute anything.
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a valid http(s) link");

const addPaymentSchema = z.object({
  employeeId: z.string().uuid("Invalid employee id"),
  paymentLink: paymentLinkSchema,
  // Date the payment was made (date-input string). Defaults to now.
  paidAt: z.string().trim().optional(),
});

const deletePaymentSchema = z.object({
  paymentId: z.string().uuid("Invalid id"),
});

export async function addSalaryPayment(data: {
  employeeId: string;
  paymentLink: string;
  paidAt?: string;
}): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requireMotha();
  const parsed = addPaymentSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const [employee] = await adminDrizzle.select({
    id: salary_employees.id, discord_name: salary_employees.discord_name,
  }).from(salary_employees).where(eq(salary_employees.id, parsed.data.employeeId)).limit(1);
  if (!employee) return { success: false, error: "Employee not found" };

  let paidAt = new Date();
  if (parsed.data.paidAt) {
    const d = new Date(parsed.data.paidAt);
    if (Number.isNaN(d.getTime())) {
      return { success: false, error: "Invalid date" };
    }
    paidAt = d;
  }

  const [created] = await adminDrizzle.insert(salary_payments).values({
      employee_id: employee.id,
      payment_link: parsed.data.paymentLink,
      paid_at: paidAt.toISOString(),
      created_by_id: session.userId,
    }).returning({ id: salary_payments.id });
  if (!created) throw new Error("Salary payment insert returned no row");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_payment_tracked",
    metadata: {
      paymentId: created.id,
      employeeId: employee.id,
      employeeDiscordName: employee.discord_name,
      paidAt: paidAt.toISOString(),
    },
  });

  revalidatePath("/salaries");
  return { success: true, id: created.id };
}

export async function deleteSalaryPayment(
  paymentId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireMotha();
  const parsed = deletePaymentSchema.safeParse({ paymentId });
  if (!parsed.success) {
    return { success: false, error: "Invalid id" };
  }

  // A real DB failure (pool timeout, connection loss) must not be
  // misreported as a benign missing row — log it and say so; "not found"
  // is reserved for an actual zero-row delete.
  let deleted: { id: string }[];
  try {
    deleted = await adminDrizzle.delete(salary_payments)
      .where(eq(salary_payments.id, parsed.data.paymentId))
      .returning({ id: salary_payments.id });
  } catch (error) {
    logError("salaries.deletePayment", "salary payment delete failed", error);
    return { success: false, error: "Couldn't delete the payment. Please try again." };
  }
  if (deleted.length === 0) {
    return { success: false, error: "Payment not found" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_payment_deleted",
    metadata: { paymentId: parsed.data.paymentId },
  });

  revalidatePath("/salaries");
  return { success: true };
}
