"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  BackendApiError,
  creatorsApi,
  type CreateDealInput,
  type UpdateDealInput,
} from "@/lib/backend-api";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Backend-API-driven creator admin actions.
 *
 * These wrap the `/v1/admin/creators/*` endpoints — each action runs
 * under the logged-in admin's session (`requirePageAccess`), calls the
 * typed `creatorsApi` client, writes a local admin-audit row for the
 * acting admin, then revalidates the affected pages.
 *
 * All backend state changes (role flip, deal create/update/terminate,
 * session force-end) happen on the main backend inside its own
 * advisory-lock transactions — the admin panel is never the source of
 * truth. Local side-effects that still belong to the admin DB (e.g.
 * affiliate_code + admin_user bootstrapping during onboarding) remain in
 * the legacy `actions.ts#makeCreator` flow for now.
 */

const toActionError = (err: unknown): Error => {
  if (err instanceof BackendApiError) {
    return new Error(err.code ? `${err.message} (${err.code})` : err.message);
  }
  return err instanceof Error ? err : new Error("Unknown backend error");
};

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

export async function promoteUserToCreator(userId: string) {
  const session = await requirePageAccess("/creators");
  try {
    const result = await creatorsApi.promote(userId);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_made_creator",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        already_creator: result.already_creator,
      },
    });

    revalidatePath("/creators");
    revalidatePath(`/creators/${userId}`);
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function demoteCreator(userId: string) {
  const session = await requirePageAccess("/creators");
  try {
    const result = await creatorsApi.demote(userId);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_demoted_from_creator",
      targetUserId: userId,
      metadata: { via: "backend_api" },
    });

    revalidatePath("/creators");
    revalidatePath(`/creators/${userId}`);
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// Deals — create / update / terminate
// ---------------------------------------------------------------------------

const CreateDealSchema = z.object({
  week_start_utc: z.string().datetime(),
  week_end_utc: z.string().datetime(),
  status: z.enum(["scheduled", "active"]).optional(),
  fills_allowed: z.number().int().positive(),
  per_fill_amount_usd: z.number().positive(),
  conversion_rate_bps: z.number().int().min(0).max(10000),
  cooldown_minutes: z.number().int().min(0).optional(),
  max_tip_per_stream_usd: z.number().min(0),
  max_tip_per_user_usd: z.number().min(0),
  max_sponsored_battle_usd: z.number().min(0),
  allow_site_leaderboards: z.boolean().optional(),
  allow_code_leaderboards: z.boolean().optional(),
  terms: z.record(z.string(), z.unknown()).nullable().optional(),
}) satisfies z.ZodType<CreateDealInput>;

export async function createCreatorDeal(
  userId: string,
  input: CreateDealInput,
) {
  const session = await requirePageAccess("/creators");
  const parsed = CreateDealSchema.parse(input);

  try {
    const deal = await creatorsApi.createDeal(userId, parsed);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_deal_created",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: deal.id,
        week_start_utc: deal.week_start_utc,
        week_end_utc: deal.week_end_utc,
        fills_allowed: deal.fills_allowed,
        per_fill_amount_usd: deal.per_fill_amount_usd,
        conversion_rate_bps: deal.conversion_rate_bps,
      },
    });

    revalidatePath(`/creators/${userId}`);
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

const UpdateDealPatchSchema = z
  .object({
    week_start_utc: z.string().datetime().optional(),
    week_end_utc: z.string().datetime().optional(),
    fills_allowed: z.number().int().positive().optional(),
    per_fill_amount_usd: z.number().positive().optional(),
    conversion_rate_bps: z.number().int().min(0).max(10000).optional(),
    cooldown_minutes: z.number().int().min(0).optional(),
    max_tip_per_stream_usd: z.number().min(0).optional(),
    max_tip_per_user_usd: z.number().min(0).optional(),
    max_sponsored_battle_usd: z.number().min(0).optional(),
    allow_site_leaderboards: z.boolean().optional(),
    allow_code_leaderboards: z.boolean().optional(),
    terms: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Patch must contain at least one field",
  });

export async function updateCreatorDeal(
  userId: string,
  dealId: string,
  expectedVersion: number,
  patch: UpdateDealInput["patch"],
) {
  const session = await requirePageAccess("/creators");
  const parsedPatch = UpdateDealPatchSchema.parse(patch);

  try {
    const deal = await creatorsApi.updateDeal(userId, dealId, {
      expected_version: expectedVersion,
      patch: parsedPatch,
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_deal_updated",
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

export async function terminateCreatorDeal(
  userId: string,
  dealId: string,
  options: { reason?: string; force_end_active_session?: boolean } = {},
) {
  const session = await requirePageAccess("/creators");

  try {
    const deal = await creatorsApi.terminateDeal(userId, dealId, options);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_deal_deleted",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        deal_id: dealId,
        reason: options.reason ?? null,
        force_ended_active_session: !!options.force_end_active_session,
      },
    });

    revalidatePath(`/creators/${userId}`);
    return deal;
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function forceEndCreatorSession(
  userId: string,
  sessionId: string,
  options: { reason?: string } = {},
) {
  const session = await requirePageAccess("/creators");

  try {
    const ended = await creatorsApi.forceEndSession(
      userId,
      sessionId,
      options,
    );

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_session_force_ended",
      targetUserId: userId,
      metadata: {
        via: "backend_api",
        session_id: sessionId,
        deal_id: ended.deal_id,
        reason: options.reason ?? null,
      },
    });

    revalidatePath(`/creators/${userId}`);
    return ended;
  } catch (err) {
    throw toActionError(err);
  }
}
