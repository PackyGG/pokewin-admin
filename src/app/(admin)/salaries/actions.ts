"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ensureSalarySchema } from "@/lib/salary/ensure-schema";
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
});

const updateEmployeeSchema = employeeSchema.partial().extend({
  id: z.string().uuid(),
});

// Manual payout entry — a founder sent USDT from their own wallet
// and is recording it after the fact. tx_hash is optional but the
// UI strongly encourages pasting the etherscan link.
const recordPayoutSchema = z.object({
  employeeId: z.string().uuid(),
  amountUsdt: z.number().finite().positive().max(10_000_000),
  txHash: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{64}$/, "Tx hash must be 0x + 64 hex chars")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
  paidAt: z
    .string()
    .datetime()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const deletePayoutSchema = z.object({
  payoutId: z.string().uuid(),
});

// All write actions self-heal the schema so a missing migration
// doesn't surface as a P2021 to the admin. The page does the same.
async function ensure(): Promise<void> {
  await ensureSalarySchema().catch(() => {});
}

// ── Employees ───────────────────────────────────────────────────────

export async function addSalaryEmployee(
  data: z.infer<typeof employeeSchema>,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requireMotha();
  await ensure();
  const parsed = employeeSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const address = parsed.data.ethAddress.trim();
  if (!isAddress(address)) {
    return { success: false, error: "Invalid Ethereum address" };
  }

  const created = await adminDb.salary_employees.create({
    data: {
      discord_name: parsed.data.discordName,
      eth_address: normalizeAddress(address),
      cadence: parsed.data.cadence ?? "monthly",
      salary_usdt: parsed.data.salaryUsdt,
      max_per_payout: null,
      notes: parsed.data.notes?.trim() || null,
      active: parsed.data.active ?? true,
      created_by_id: session.userId,
    },
    select: { id: true },
  });

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
  await ensure();
  const parsed = updateEmployeeSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const updateData: Record<string, unknown> = {};
  if (parsed.data.discordName !== undefined)
    updateData.discord_name = parsed.data.discordName;
  if (parsed.data.ethAddress !== undefined) {
    if (!isAddress(parsed.data.ethAddress.trim())) {
      return { success: false, error: "Invalid Ethereum address" };
    }
    updateData.eth_address = normalizeAddress(parsed.data.ethAddress);
  }
  if (parsed.data.cadence !== undefined) updateData.cadence = parsed.data.cadence;
  if (parsed.data.salaryUsdt !== undefined)
    updateData.salary_usdt = parsed.data.salaryUsdt;
  if (parsed.data.notes !== undefined) {
    updateData.notes = parsed.data.notes?.trim() || null;
  }
  if (parsed.data.active !== undefined) updateData.active = parsed.data.active;

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "Nothing to update" };
  }

  await adminDb.salary_employees.update({
    where: { id: parsed.data.id },
    data: updateData,
    select: { id: true },
  });

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
  await ensure();
  if (!z.string().uuid().safeParse(employeeId).success) {
    return { success: false, error: "Invalid id" };
  }
  // Refuse to delete if there are payouts on file — historical record
  // matters. Mark inactive instead.
  const payoutCount = await adminDb.salary_payouts.count({
    where: { employee_id: employeeId },
  });
  if (payoutCount > 0) {
    return {
      success: false,
      error: `Cannot delete — ${payoutCount} payout${payoutCount === 1 ? "" : "s"} on record. Deactivate instead.`,
    };
  }

  await adminDb.salary_employees.delete({
    where: { id: employeeId },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_employee_deleted",
    metadata: { employeeId },
  });

  revalidatePath("/salaries");
  return { success: true };
}

// ── Manual payout log ───────────────────────────────────────────────

/**
 * Record a payment that was sent off-system (a founder scanned the
 * QR, sent USDT from their personal wallet). Optionally store the
 * etherscan tx hash so future founders (or audit) can verify on
 * chain.
 *
 * No 2FA gate — recording history is informational, not a money-
 * moving operation. The founder username gate is the access
 * boundary.
 */
export async function recordSalaryPayout(
  data: z.infer<typeof recordPayoutSchema>,
): Promise<{ success: true; payoutId: string } | { success: false; error: string }> {
  const session = await requireMotha();
  await ensure();
  const parsed = recordPayoutSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const employee = await adminDb.salary_employees.findUnique({
    where: { id: parsed.data.employeeId },
  });
  if (!employee) return { success: false, error: "Employee not found" };

  // Pre-check tx_hash uniqueness so we can return a friendly error
  // instead of letting the unique-index violation bubble up.
  if (parsed.data.txHash) {
    const existing = await adminDb.salary_payouts.findUnique({
      where: { tx_hash: parsed.data.txHash },
    });
    if (existing) {
      return {
        success: false,
        error: "That tx hash is already recorded against another payout",
      };
    }
  }

  const paidAt = parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date();

  const payout = await adminDb.salary_payouts.create({
    data: {
      employee_id: employee.id,
      amount_usdt: parsed.data.amountUsdt,
      to_address: employee.eth_address,
      tx_hash: parsed.data.txHash ?? null,
      // We reuse the existing schema; "confirmed" means a founder
      // logged the payment. There's no on-chain polling anymore.
      status: "confirmed",
      broadcast_at: paidAt,
      confirmed_at: paidAt,
      error_message: parsed.data.notes ?? null,
      paid_by_id: session.userId,
    },
    select: { id: true },
  });

  // last_paid_at is the cheapest "when did we last pay" badge for
  // the employees table.
  await adminDb.salary_employees.update({
    where: { id: employee.id },
    data: { last_paid_at: paidAt },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_payout_recorded",
    metadata: {
      payoutId: payout.id,
      employeeId: employee.id,
      employeeDiscordName: employee.discord_name,
      amountUsdt: parsed.data.amountUsdt,
      txHash: parsed.data.txHash ?? null,
      paidAt: paidAt.toISOString(),
    },
  });

  revalidatePath("/salaries");
  return { success: true, payoutId: payout.id };
}

export async function deleteSalaryPayout(
  payoutId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireMotha();
  await ensure();
  const parsed = deletePayoutSchema.safeParse({ payoutId });
  if (!parsed.success) {
    return { success: false, error: "Invalid id" };
  }

  await adminDb.salary_payouts.delete({
    where: { id: parsed.data.payoutId },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_payout_deleted",
    metadata: { payoutId: parsed.data.payoutId },
  });

  revalidatePath("/salaries");
  return { success: true };
}
