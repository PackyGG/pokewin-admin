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
  // Recurring pay day as a day of the month (1-31). null clears it.
  payDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
});

const updateEmployeeSchema = employeeSchema.partial().extend({
  id: z.string().uuid(),
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
    return {
      success: false,
      error: "Invalid wallet address — use an ERC-20 (0x…) or Solana address",
    };
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
      pay_day_of_month: parsed.data.payDayOfMonth ?? null,
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
      return {
        success: false,
        error: "Invalid wallet address — use an ERC-20 (0x…) or Solana address",
      };
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
  if (parsed.data.payDayOfMonth !== undefined)
    updateData.pay_day_of_month = parsed.data.payDayOfMonth;

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

// Manual payment logging (recordSalaryPayout / deleteSalaryPayout) was
// removed — this page is now just the recipient registry. The
// salary_payouts table is kept (historical rows + the delete guard in
// deleteSalaryEmployee), but nothing writes to it from here anymore.
