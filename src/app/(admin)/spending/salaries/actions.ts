"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { require2FA } from "@/lib/require-2fa";
import { requireMotha } from "@/lib/salary/motha-gate";
import {
  deriveAddress,
  getTxStatus,
  isAddress,
  isValidPrivateKey,
  normalizePrivateKey,
  transferUsdt,
} from "@/lib/salary/wallet";

const WALLET_SINGLETON_ID = "singleton";

// ── Schemas ─────────────────────────────────────────────────────────

const setKeySchema = z.object({
  privateKey: z.string().min(1, "Private key is required"),
  rpcUrl: z.string().url().nullable().optional(),
  totpCode: z.string().min(6, "2FA code is required"),
});

const employeeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  ethAddress: z.string().trim().min(1, "Address is required"),
  salaryUsdt: z
    .number()
    .finite()
    .positive("Salary must be > 0")
    .max(1_000_000),
  maxPerPayout: z
    .number()
    .finite()
    .positive()
    .max(10_000_000)
    .nullable()
    .optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

const paySchema = z.object({
  employeeId: z.string().uuid(),
  amountUsdt: z.number().finite().positive().max(10_000_000),
  totpCode: z.string().min(6, "2FA code is required"),
});

// ── Wallet key ──────────────────────────────────────────────────────

export async function setSalaryWalletKey(
  data: z.infer<typeof setKeySchema>,
): Promise<{ success: true; address: string } | { success: false; error: string }> {
  const session = await requireMotha();
  const parsed = setKeySchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  // 2FA — even motha must re-prove before swapping the payout key.
  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  if (!isValidPrivateKey(parsed.data.privateKey)) {
    return { success: false, error: "Private key is not a valid Ethereum key" };
  }

  const normalized = normalizePrivateKey(parsed.data.privateKey);
  const derived = deriveAddress(normalized);

  await adminDb.salary_wallet.upsert({
    where: { id: WALLET_SINGLETON_ID },
    create: {
      id: WALLET_SINGLETON_ID,
      private_key: normalized,
      rpc_url: parsed.data.rpcUrl ?? null,
      updated_by_id: session.userId,
    },
    update: {
      private_key: normalized,
      rpc_url: parsed.data.rpcUrl ?? null,
      updated_by_id: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_wallet_key_updated",
    metadata: {
      address: derived,
      hasRpcUrl: Boolean(parsed.data.rpcUrl),
    },
  });

  revalidatePath("/spending/salaries");
  return { success: true, address: derived };
}

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
    return { success: false, error: "Invalid Ethereum address" };
  }

  const created = await adminDb.salary_employees.create({
    data: {
      name: parsed.data.name,
      eth_address: address.toLowerCase(),
      salary_usdt: parsed.data.salaryUsdt,
      max_per_payout: parsed.data.maxPerPayout ?? null,
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
      name: parsed.data.name,
      ethAddress: address.toLowerCase(),
      salaryUsdt: parsed.data.salaryUsdt,
    },
  });

  revalidatePath("/spending/salaries");
  return { success: true, id: created.id };
}

const updateEmployeeSchema = employeeSchema.partial().extend({
  id: z.string().uuid(),
});

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
  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.ethAddress !== undefined) {
    if (!isAddress(parsed.data.ethAddress.trim())) {
      return { success: false, error: "Invalid Ethereum address" };
    }
    updateData.eth_address = parsed.data.ethAddress.trim().toLowerCase();
  }
  if (parsed.data.salaryUsdt !== undefined)
    updateData.salary_usdt = parsed.data.salaryUsdt;
  if (parsed.data.maxPerPayout !== undefined)
    updateData.max_per_payout = parsed.data.maxPerPayout;
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

  revalidatePath("/spending/salaries");
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

  revalidatePath("/spending/salaries");
  return { success: true };
}

// ── Pay ─────────────────────────────────────────────────────────────

export async function paySalary(
  data: z.infer<typeof paySchema>,
): Promise<
  | { success: true; payoutId: string; txHash: string }
  | { success: false; error: string }
> {
  const session = await requireMotha();
  const parsed = paySchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // 2FA per payout — REAL money leaves the wallet on success.
  try {
    await require2FA(session.userId, parsed.data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  const [employee, wallet] = await Promise.all([
    adminDb.salary_employees.findUnique({
      where: { id: parsed.data.employeeId },
    }),
    adminDb.salary_wallet.findUnique({ where: { id: WALLET_SINGLETON_ID } }),
  ]);
  if (!employee) return { success: false, error: "Employee not found" };
  if (!employee.active)
    return { success: false, error: "Employee is inactive" };
  if (!wallet)
    return {
      success: false,
      error: "No payout wallet configured — set the private key first",
    };

  // Hard cap protection — typo defense.
  if (employee.max_per_payout) {
    const cap = Number(employee.max_per_payout);
    if (parsed.data.amountUsdt > cap) {
      return {
        success: false,
        error: `Amount $${parsed.data.amountUsdt.toFixed(2)} exceeds this employee's per-payout cap ($${cap.toFixed(2)})`,
      };
    }
  }

  // Insert pending payout BEFORE broadcasting so a crash mid-send
  // leaves a "we tried" record. tx_hash is filled on success.
  const payout = await adminDb.salary_payouts.create({
    data: {
      employee_id: employee.id,
      amount_usdt: parsed.data.amountUsdt,
      to_address: employee.eth_address,
      status: "pending",
      paid_by_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_payout_started",
    metadata: {
      payoutId: payout.id,
      employeeId: employee.id,
      employeeName: employee.name,
      amountUsdt: parsed.data.amountUsdt,
      toAddress: employee.eth_address,
    },
  });

  const result = await transferUsdt({
    privateKey: wallet.private_key,
    rpcOverride: wallet.rpc_url,
    to: employee.eth_address,
    amountUsdt: parsed.data.amountUsdt,
  });

  if (!result.ok) {
    await adminDb.salary_payouts.update({
      where: { id: payout.id },
      data: {
        status: "failed",
        error_message: result.error,
        failed_at: new Date(),
      },
      select: { id: true },
    });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "salary_payout_failed",
      metadata: { payoutId: payout.id, error: result.error },
    });
    revalidatePath("/spending/salaries");
    return { success: false, error: result.error };
  }

  // Broadcast OK — record tx hash + last_paid_at. Confirmation
  // happens via refreshSalaryPayoutStatus polling.
  await adminDb.$transaction([
    adminDb.salary_payouts.update({
      where: { id: payout.id },
      data: {
        tx_hash: result.txHash,
        status: "broadcast",
        broadcast_at: new Date(),
      },
      select: { id: true },
    }),
    adminDb.salary_employees.update({
      where: { id: employee.id },
      data: { last_paid_at: new Date() },
      select: { id: true },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "salary_payout_broadcast",
    metadata: { payoutId: payout.id, txHash: result.txHash },
  });

  revalidatePath("/spending/salaries");
  return { success: true, payoutId: payout.id, txHash: result.txHash };
}

/**
 * Re-poll one payout's tx receipt. UI calls this from a polling
 * loop after broadcast — when status flips to confirmed/failed the
 * loop stops.
 */
export async function refreshSalaryPayoutStatus(
  payoutId: string,
): Promise<{ status: "pending" | "broadcast" | "confirmed" | "failed" }> {
  await requireMotha();
  if (!z.string().uuid().safeParse(payoutId).success) {
    return { status: "pending" };
  }
  const payout = await adminDb.salary_payouts.findUnique({
    where: { id: payoutId },
  });
  if (!payout) return { status: "pending" };
  if (payout.status === "confirmed" || payout.status === "failed")
    return { status: payout.status as "confirmed" | "failed" };
  if (!payout.tx_hash) return { status: payout.status as "pending" | "broadcast" };

  const wallet = await adminDb.salary_wallet.findUnique({
    where: { id: WALLET_SINGLETON_ID },
  });
  const onChain = await getTxStatus(payout.tx_hash, wallet?.rpc_url);
  if (onChain === "confirmed") {
    await adminDb.salary_payouts.update({
      where: { id: payoutId },
      data: { status: "confirmed", confirmed_at: new Date() },
      select: { id: true },
    });
    revalidatePath("/spending/salaries");
    return { status: "confirmed" };
  }
  if (onChain === "failed") {
    await adminDb.salary_payouts.update({
      where: { id: payoutId },
      data: {
        status: "failed",
        failed_at: new Date(),
        error_message: "On-chain status: failed",
      },
      select: { id: true },
    });
    revalidatePath("/spending/salaries");
    return { status: "failed" };
  }
  return { status: "broadcast" };
}
