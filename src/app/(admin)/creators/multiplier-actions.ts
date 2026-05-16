"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  BackendApiError,
  multiplierDealsApi,
  type CreateMultiplierDealInput,
  type UpdateMultiplierDealInput,
} from "@/lib/backend-api";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Server actions for the multiplier-deal admin surface.
 *
 * Each action mirrors a backend `/v1/admin/...` endpoint, guarded by the
 * relevant `__can_*` capability and writing an `admin_audit_events` row
 * with the actor and meaningful metadata. Backend is the source of truth
 * for lifecycle and money movement — this layer is auth + audit only.
 *
 * Audit event types (text column, no schema migration needed):
 *   multiplier_deal_created
 *   multiplier_deal_updated
 *   multiplier_deal_cancelled
 *   multiplier_deal_force_ended
 *   multiplier_deal_approved
 *   multiplier_deal_rejected
 *   multiplier_deal_flagged
 *
 * Capabilities (added in permissions-utils.ts):
 *   __can_create_multiplier_deal       create + cancel pending offers
 *   __can_update_multiplier_deal       edit pending offer terms
 *   __can_force_end_multiplier_stream  force-end live stream
 *   __can_review_multiplier_deal       approve / reject / flag (settlement)
 */

const toActionError = (err: unknown): Error => {
  if (err instanceof BackendApiError) {
    return new Error(err.code ? `${err.message} (${err.code})` : err.message);
  }
  return err instanceof Error ? err : new Error("Unknown backend error");
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CurrencyAmount = z.number().min(0);
const PositiveAmount = z.number().positive();

const CreateMultiplierDealSchema = z.object({
  required_deposit_usd: PositiveAmount,
  multiplier_bps: z.number().int().min(10000),
  withdrawable_bps: z.number().int().min(0).max(10000).optional(),
  wager_requirement_bps: z.number().int().min(0).optional(),
  max_total_wager_usd: CurrencyAmount.nullable().optional(),
  max_payout_usd: CurrencyAmount.nullable().optional(),
  min_session_duration_seconds: z.number().int().min(0).optional(),
  min_bet_count: z.number().int().min(0).optional(),
  min_wager_to_funding_ratio_bps: z.number().int().min(0).max(10000).optional(),
  kick_vod_required: z.boolean().optional(),
  terms_text: z.string().min(1).max(20000),
  terms_version: z.string().min(1).max(64),
}) satisfies z.ZodType<CreateMultiplierDealInput>;

const UpdateMultiplierDealPatchSchema = z
  .object({
    required_deposit_usd: PositiveAmount.optional(),
    multiplier_bps: z.number().int().min(10000).optional(),
    withdrawable_bps: z.number().int().min(0).max(10000).optional(),
    wager_requirement_bps: z.number().int().min(0).optional(),
    max_total_wager_usd: CurrencyAmount.nullable().optional(),
    max_payout_usd: CurrencyAmount.nullable().optional(),
    min_session_duration_seconds: z.number().int().min(0).optional(),
    min_bet_count: z.number().int().min(0).optional(),
    min_wager_to_funding_ratio_bps: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional(),
    kick_vod_required: z.boolean().optional(),
    terms_text: z.string().min(1).max(20000).optional(),
    terms_version: z.string().min(1).max(64).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, {
    message: "Patch must contain at least one field",
  });

const ApproveSchema = z.object({
  override_wager_requirement: z.boolean().optional(),
  payout_override_usd: CurrencyAmount.optional(),
  reason: z.string().max(500).optional(),
});

const RejectSchema = z.object({
  reason: z.string().min(1).max(500),
  forfeit_deposit_usd: CurrencyAmount.optional(),
});

const FlagSchema = z.object({
  code: z.string().min(1).max(64),
  detail: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Create / Update / Cancel
// ---------------------------------------------------------------------------

export async function createMultiplierDeal(
  userId: string,
  input: CreateMultiplierDealInput,
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_create_multiplier_deal",
    "create multiplier deals",
  );
  const parsed = CreateMultiplierDealSchema.parse(input);

  try {
    const deal = await multiplierDealsApi.create(userId, parsed);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_created",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: deal.id,
        required_deposit_usd: deal.required_deposit_usd,
        multiplier_bps: deal.multiplier_bps,
        withdrawable_bps: deal.withdrawable_bps,
        wager_requirement_bps: deal.wager_requirement_bps,
        terms_version: deal.terms_version,
      },
    });

    revalidatePath(`/creators/${userId}`);
    revalidatePath("/creators/multiplier-review");
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function updateMultiplierDeal(
  userId: string,
  dealId: string,
  expectedVersion: number,
  patch: UpdateMultiplierDealInput["patch"],
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_update_multiplier_deal",
    "update multiplier deals",
  );
  const parsedPatch = UpdateMultiplierDealPatchSchema.parse(patch);

  try {
    const deal = await multiplierDealsApi.update(userId, dealId, {
      expected_version: expectedVersion,
      patch: parsedPatch,
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_updated",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        patch: parsedPatch,
        new_version: deal.version,
      },
    });

    revalidatePath(`/creators/${userId}`);
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function cancelMultiplierDeal(
  userId: string,
  dealId: string,
  options: { reason?: string } = {},
) {
  const session = await requirePageAccess("/creators");
  // Cancel is part of the offer-management lifecycle (only valid for
  // pending_deposit / funded), so we gate it on the create capability
  // rather than spinning up a separate __can_cancel_multiplier_deal.
  await requireCapability(
    session,
    "__can_create_multiplier_deal",
    "cancel multiplier deals",
  );

  try {
    const deal = await multiplierDealsApi.cancel(userId, dealId, options);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_cancelled",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        reason: options.reason ?? null,
        deposit_refunded_usd: deal.deposit_refunded_usd,
      },
    });

    revalidatePath(`/creators/${userId}`);
    revalidatePath("/creators/multiplier-review");
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// Force-end (live → pending_review/flagged)
// ---------------------------------------------------------------------------

export async function forceEndMultiplierStream(
  userId: string,
  dealId: string,
  options: { reason?: string } = {},
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_force_end_multiplier_stream",
    "force-end multiplier stream",
  );

  try {
    const deal = await multiplierDealsApi.forceEnd(userId, dealId, options);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_force_ended",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        reason: options.reason ?? null,
        final_status: deal.status,
      },
    });

    revalidatePath(`/creators/${userId}`);
    revalidatePath("/creators/multiplier-review");
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// Review actions — approve / reject / flag (settlement)
// ---------------------------------------------------------------------------

export async function approveMultiplierDeal(
  userId: string,
  dealId: string,
  input: {
    override_wager_requirement?: boolean;
    payout_override_usd?: number;
    reason?: string;
  } = {},
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_review_multiplier_deal",
    "approve multiplier deals",
  );
  const parsed = ApproveSchema.parse(input);

  try {
    const deal = await multiplierDealsApi.approve(userId, dealId, parsed);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_approved",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        override_wager_requirement:
          parsed.override_wager_requirement ?? false,
        payout_override_usd: parsed.payout_override_usd ?? null,
        reason: parsed.reason ?? null,
        withdrawable_voucher_usd: deal.withdrawable_voucher_usd,
        forfeited_usd: deal.forfeited_usd,
        payout_voucher_id: deal.payout_voucher_id,
      },
    });

    revalidatePath(`/creators/${userId}`);
    revalidatePath("/creators/multiplier-review");
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function rejectMultiplierDeal(
  userId: string,
  dealId: string,
  input: { reason: string; forfeit_deposit_usd?: number },
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_review_multiplier_deal",
    "reject multiplier deals",
  );
  const parsed = RejectSchema.parse(input);

  try {
    const deal = await multiplierDealsApi.reject(userId, dealId, parsed);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_rejected",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        reason: parsed.reason,
        forfeit_deposit_usd: parsed.forfeit_deposit_usd ?? 0,
        deposit_refunded_usd: deal.deposit_refunded_usd,
        deposit_forfeited_usd: deal.deposit_forfeited_usd,
      },
    });

    revalidatePath(`/creators/${userId}`);
    revalidatePath("/creators/multiplier-review");
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function flagMultiplierDeal(
  userId: string,
  dealId: string,
  input: { code: string; detail?: Record<string, unknown>; reason?: string },
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_review_multiplier_deal",
    "flag multiplier deals",
  );
  const parsed = FlagSchema.parse(input);

  try {
    const deal = await multiplierDealsApi.flag(userId, dealId, parsed);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "multiplier_deal_flagged",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        manual_code: parsed.code,
        detail: parsed.detail ?? null,
        reason: parsed.reason ?? null,
      },
    });

    revalidatePath(`/creators/${userId}`);
    revalidatePath("/creators/multiplier-review");
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// Read helpers (server-only queries reused by pages)
// ---------------------------------------------------------------------------

export async function listMultiplierDealsForCreator(
  userId: string,
  query: { offset?: number; limit?: number } = {},
) {
  await requirePageAccess("/creators");
  try {
    return await multiplierDealsApi.list(userId, query);
  } catch (err) {
    throw toActionError(err);
  }
}

export async function getMultiplierDeal(userId: string, dealId: string) {
  await requirePageAccess("/creators");
  try {
    return await multiplierDealsApi.get(userId, dealId);
  } catch (err) {
    throw toActionError(err);
  }
}

export async function listMultiplierReviewQueue(
  query: { offset?: number; limit?: number; flagged_only?: boolean } = {},
) {
  await requirePageAccess("/creators");
  try {
    return await multiplierDealsApi.listReviewQueue(query);
  } catch (err) {
    throw toActionError(err);
  }
}
