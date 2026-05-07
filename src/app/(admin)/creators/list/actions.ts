"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ensureCreatorEstimatesSchema } from "@/lib/creator-estimates/ensure-schema";
import { requirePageAccess } from "@/lib/dal";

// ── Schemas ─────────────────────────────────────────────────────────

const CADENCES = ["weekly", "biweekly", "monthly"] as const;

// All optional spend caps must be non-negative numbers when present.
// Percent fields are 0-100, not 0-1, so admins can type "20" instead
// of "0.2" — the UI label says "%" so this matches expectations.
const optionalDollarAmount = z
  .number()
  .finite()
  .nonnegative()
  .max(10_000_000)
  .nullable()
  .optional();

const optionalPercent = z
  .number()
  .finite()
  .nonnegative()
  .max(100)
  .nullable()
  .optional();

const estimateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  cadence: z.enum(CADENCES),
  fillAmountUsd: optionalDollarAmount,
  fillPercent: optionalPercent,
  withdrawalCapUsd: optionalDollarAmount,
  withdrawalPercent: optionalPercent,
  tipCapUsd: optionalDollarAmount,
  freeBattleCapUsd: optionalDollarAmount,
  notes: z.string().trim().max(500).nullable().optional(),
});

const updateSchema = estimateSchema.partial().extend({
  id: z.string().uuid(),
});

// All write actions self-heal the schema so a missing migration
// doesn't surface as a P2021 to the admin. The page does the same.
async function ensure(): Promise<void> {
  await ensureCreatorEstimatesSchema().catch(() => {});
}

// ── Create ──────────────────────────────────────────────────────────

export async function createCreatorEstimate(
  data: z.infer<typeof estimateSchema>,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requirePageAccess("/creators/list");
  await ensure();
  const parsed = estimateSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const created = await adminDb.creator_deal_estimates.create({
    data: {
      name: parsed.data.name,
      cadence: parsed.data.cadence,
      fill_amount_usd: parsed.data.fillAmountUsd ?? null,
      fill_percent: parsed.data.fillPercent ?? null,
      withdrawal_cap_usd: parsed.data.withdrawalCapUsd ?? null,
      withdrawal_percent: parsed.data.withdrawalPercent ?? null,
      tip_cap_usd: parsed.data.tipCapUsd ?? null,
      free_battle_cap_usd: parsed.data.freeBattleCapUsd ?? null,
      notes: parsed.data.notes?.trim() || null,
      created_by_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_estimate_created",
    metadata: {
      estimateId: created.id,
      name: parsed.data.name,
      cadence: parsed.data.cadence,
    },
  });

  revalidatePath("/creators/list");
  return { success: true, id: created.id };
}

// ── Update ──────────────────────────────────────────────────────────

export async function updateCreatorEstimate(
  data: z.infer<typeof updateSchema>,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/creators/list");
  await ensure();
  const parsed = updateSchema.safeParse(data);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.cadence !== undefined) updateData.cadence = parsed.data.cadence;
  if (parsed.data.fillAmountUsd !== undefined)
    updateData.fill_amount_usd = parsed.data.fillAmountUsd;
  if (parsed.data.fillPercent !== undefined)
    updateData.fill_percent = parsed.data.fillPercent;
  if (parsed.data.withdrawalCapUsd !== undefined)
    updateData.withdrawal_cap_usd = parsed.data.withdrawalCapUsd;
  if (parsed.data.withdrawalPercent !== undefined)
    updateData.withdrawal_percent = parsed.data.withdrawalPercent;
  if (parsed.data.tipCapUsd !== undefined)
    updateData.tip_cap_usd = parsed.data.tipCapUsd;
  if (parsed.data.freeBattleCapUsd !== undefined)
    updateData.free_battle_cap_usd = parsed.data.freeBattleCapUsd;
  if (parsed.data.notes !== undefined) {
    updateData.notes = parsed.data.notes?.trim() || null;
  }

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "Nothing to update" };
  }

  await adminDb.creator_deal_estimates.update({
    where: { id: parsed.data.id },
    data: updateData,
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_estimate_updated",
    metadata: { estimateId: parsed.data.id, fields: Object.keys(updateData) },
  });

  revalidatePath("/creators/list");
  return { success: true };
}

// ── Delete ──────────────────────────────────────────────────────────

export async function deleteCreatorEstimate(
  estimateId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/creators/list");
  await ensure();
  if (!z.string().uuid().safeParse(estimateId).success) {
    return { success: false, error: "Invalid id" };
  }

  await adminDb.creator_deal_estimates.delete({
    where: { id: estimateId },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_estimate_deleted",
    metadata: { estimateId },
  });

  revalidatePath("/creators/list");
  return { success: true };
}
