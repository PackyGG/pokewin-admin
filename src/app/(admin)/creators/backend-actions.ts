"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import {
  BackendApiError,
  creatorsApi,
  type CreateDealInput,
  type UpdateDealInput,
} from "@/lib/backend-api";
import {
  requirePageAccess,
  verifySession,
  sessionIsAdmin,
  getUserPermissions,
} from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
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
  await requireCapability(session, "__can_make_creator", "promote a user to creator");
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
    revalidatePath("/creator-hub/creators");
    revalidatePath(`/creator-hub/creators/${userId}`);
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function demoteCreator(userId: string) {
  const session = await requirePageAccess("/creators");
  // Symmetric with `promoteUserToCreator`: demoting is the inverse of
  // promoting, so it gates on the same capability. Without this, any
  // /creators-page-access role could revoke creator status without the
  // promote-side check applying.
  await requireCapability(session, "__can_make_creator", "demote creator");
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
  total_withdraw_cap_usd: z.number().min(0).nullable().optional(),
  cooldown_minutes: z.number().int().min(0).optional(),
  max_tip_per_stream_usd: z.number().min(0),
  max_tip_per_user_usd: z.number().min(0),
  max_sponsored_battle_usd: z.number().min(0),
  max_sponsorship_per_stream_usd: z.number().min(0),
  allow_site_leaderboards: z.boolean().optional(),
  allow_code_leaderboards: z.boolean().optional(),
  terms: z.record(z.string(), z.unknown()).nullable().optional(),
}) satisfies z.ZodType<CreateDealInput>;

/**
 * Admin page access OR Creator Hub access — for the deal-create mutation,
 * which is reachable from BOTH the admin page and the hub's New Deal
 * dialog. `requirePageAccess` REDIRECTS on denial, which ejected a
 * hub-toggle-only creator_manager out of the hub mid-dialog; this throws
 * instead so the dialog surfaces a toast. Same shape as the
 * freezeClaim/unfreezeClaim precedent in leaderboards/actions.ts.
 * Fail-closed: admin → /creators page permission → requireCreatorHubAccess
 * (throws on denial). The `__can_create_creator_deal` capability check
 * below still applies unchanged to every non-admin.
 */
async function requireCreatorsPageOrHubAccess() {
  const session = await verifySession();
  if (sessionIsAdmin(session)) return session;

  const allowedPages = await getUserPermissions(session.userId);
  if (allowedPages.includes("/creators")) return session;

  return requireCreatorHubAccess("Not authorized to manage creator deals.");
}

export async function createCreatorDeal(
  userId: string,
  input: CreateDealInput,
) {
  const session = await requireCreatorsPageOrHubAccess();
  const parsed = CreateDealSchema.parse(input);
  await requireCapability(session, "__can_create_creator_deal", "create creator deals");

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
    revalidatePath(`/creator-hub/creators/${userId}`);
    // The hub Overview deal card reads through an `unstable_cache` entry
    // (60s TTL) which `revalidatePath` does NOT bust — flush its tag so a
    // freshly-created deal appears immediately.
    revalidateTag("creator-deal");
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
    total_withdraw_cap_usd: z.number().min(0).nullable().optional(),
    cooldown_minutes: z.number().int().min(0).optional(),
    max_tip_per_stream_usd: z.number().min(0).optional(),
    max_tip_per_user_usd: z.number().min(0).optional(),
    max_sponsored_battle_usd: z.number().min(0).optional(),
    max_sponsorship_per_stream_usd: z.number().min(0).optional(),
    allow_site_leaderboards: z.boolean().optional(),
    allow_code_leaderboards: z.boolean().optional(),
    terms: z.record(z.string(), z.unknown()).nullable().optional(),
    fills_used: z.number().int().min(0).optional(),
    withdraw_cap_used_usd: z.number().min(0).optional(),
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
  await requireCapability(session, "__can_update_creator_deal", "update creator deals");

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
    revalidatePath(`/creator-hub/creators/${userId}`);
    // Same stale-cache class as createCreatorDeal — the hub deal card's
    // unstable_cache entry must not serve pre-update terms for its TTL.
    revalidateTag("creator-deal");
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
  await requireCapability(session, "__can_delete_creator_deal", "delete creator deals");

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
    revalidatePath(`/creator-hub/creators/${userId}`);
    // Same stale-cache class as createCreatorDeal — a terminated deal must
    // not keep rendering "active" on the hub deal card for the TTL.
    revalidateTag("creator-deal");
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
  // TODO(audit): consider __can_force_end_session as a separate capability
  // if force-ending live sessions needs to be restricted independently of
  // promote/demote. For now we reuse the promote/demote capability so the
  // same set of trusted admins can act on the creator lifecycle.
  await requireCapability(
    session,
    "__can_make_creator",
    "force-end creator session",
  );

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

// ---------------------------------------------------------------------------
// Creator socials (review queue)
// ---------------------------------------------------------------------------

export async function listCreatorSocialQueue(
  options: {
    status?: "pending" | "approved" | "rejected";
    offset?: number;
    limit?: number;
  } = {},
) {
  await requirePageAccess("/creators");
  try {
    return await creatorsApi.listSocials(options);
  } catch (err) {
    throw toActionError(err);
  }
}

export async function approveCreatorSocial(socialId: string) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_review_creator_social",
    "approve creator socials",
  );

  try {
    const result = await creatorsApi.approveSocial(socialId);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_social_approved",
      targetUserId: result.user_id,
      metadata: {
        via: "backend_api",
        social_id: result.id,
        platform: result.platform,
        username: result.username,
      },
    });

    revalidatePath(`/creators/${result.user_id}`);
    revalidatePath(`/creators/socials`);
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

// ---------------------------------------------------------------------------
// API key — external creator endpoints (affiliate stats, leaderboards)
// ---------------------------------------------------------------------------

export async function getCreatorApiKeyStatus(userId: string) {
  await requirePageAccess("/creators");
  try {
    return await creatorsApi.getApiKeyStatus(userId);
  } catch (err) {
    throw toActionError(err);
  }
}

export async function rotateCreatorApiKey(userId: string) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_rotate_creator_api_key",
    "rotate creator API keys",
  );

  try {
    const result = await creatorsApi.rotateApiKey(userId);

    // Plain key only exists in the response — do NOT log it. Audit row
    // records the act of rotation only.
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_api_key_rotated",
      targetUserId: userId,
      metadata: { via: "backend_api" },
    });

    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function rejectCreatorSocial(
  socialId: string,
  options: { reason?: string } = {},
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_review_creator_social",
    "reject creator socials",
  );

  try {
    const result = await creatorsApi.rejectSocial(socialId, options.reason);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "creator_social_rejected",
      targetUserId: result.user_id,
      metadata: {
        via: "backend_api",
        social_id: result.id,
        platform: result.platform,
        username: result.username,
        reason: options.reason ?? null,
      },
    });

    revalidatePath(`/creators/${result.user_id}`);
    revalidatePath(`/creators/socials`);
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}
