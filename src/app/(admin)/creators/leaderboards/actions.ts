"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import {
    affiliateLeaderboardsApi,
    type EditInput,
    type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { BackendApiError } from "@/lib/backend-api/errors";
import { requirePageAccess, verifySession, sessionIsAdmin, getUserPermissions } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";

export type CreatorSearchResult = {
    userId: string;
    username: string | null;
    email: string | null;
    affiliateCode: string | null;
    codes: string[];
};

export async function searchCreators(query: string): Promise<CreatorSearchResult[]> {
    await requirePageAccess(PAGE_KEY);
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const db = await getDb();
    // Match on the creator's own affiliate codes (from affiliate_codes table),
    // not on user.affiliate_code (which is the code the user signed up with).
    const rows = await db.$queryRaw<
        Array<{
            id: string;
            username: string | null;
            email: string | null;
            codes: string[] | null;
        }>
    >`
        SELECT
            u.id,
            u.username,
            u.email,
            COALESCE(
                (
                    SELECT array_agg(ac.code ORDER BY ac.created_at ASC)
                    FROM affiliate_codes ac
                    WHERE ac.user_id = u.id
                ),
                ARRAY[]::text[]
            ) AS codes
        FROM "user" u
        WHERE u.role = 'creator'
          AND (
              u.username ILIKE ${"%" + trimmed + "%"}
              OR u.email ILIKE ${"%" + trimmed + "%"}
              OR EXISTS (
                  SELECT 1 FROM affiliate_codes ac2
                  WHERE ac2.user_id = u.id
                    AND ac2.code ILIKE ${"%" + trimmed + "%"}
              )
          )
        ORDER BY u.username ASC NULLS LAST
        LIMIT 8
    `;

    return rows.map((r) => ({
        userId: r.id,
        username: r.username,
        email: r.email,
        affiliateCode: r.codes?.[0] ?? null,
        codes: r.codes ?? [],
    }));
}

export async function getCreatorCodes(userId: string): Promise<string[]> {
    await requirePageAccess(PAGE_KEY);
    if (!userId) return [];
    const db = await getDb();
    const rows = await db.affiliate_codes.findMany({
        where: { user_id: userId },
        select: { code: true },
        orderBy: { created_at: "asc" },
    });
    return rows.map((r) => r.code);
}

const PAGE_KEY = "/creators/leaderboards";

type ActionResult<T = undefined> =
    | { success: true; data?: T }
    | { success: false; error: string };

const idSchema = z.string().uuid("Invalid leaderboard id");

const rejectSchema = z.object({
    rejection_reason: z.string().trim().min(1, "Reason is required").max(500),
});

const sponsorSchema = z.object({
    additional_bonus_usd: z.number().positive("Bonus must be positive"),
});

const createSchema = z.object({
    creator_user_id: z.string().trim().min(1, "Creator user id is required"),
    co_creator_user_ids: z.array(z.string().trim().min(1)).default([]),
    title: z.string().trim().min(1).max(100),
    affiliate_codes: z.array(z.string()).default([]),
    site_bonus_usd: z.number().positive("Total prize pool must be positive"),
    start_date: z.string().min(1, "Start date is required"),
    end_date: z.string().min(1, "End date is required"),
    prize_tiers: z
        .array(
            z.object({
                position: z.number().int().positive(),
                prize_amount_usd: z.number().positive(),
            }),
        )
        .min(5, "At least 5 prize tiers are required"),
});

const editSchema = z.object({
    title: z.string().trim().min(1).max(100).optional(),
    affiliate_codes: z.array(z.string()).optional(),
    co_creator_user_ids: z.array(z.string().trim().min(1)).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    prize_tiers: z
        .array(
            z.object({
                position: z.number().int().positive(),
                prize_amount_usd: z.number().positive(),
            }),
        )
        .min(5)
        .optional(),
    // Site-funded prize pool. Editable so admins can lower / raise a
    // leaderboard after creation; the creator-funded portion stays
    // locked at deal time. 0 is allowed (leaderboard with creator-only
    // funding); negatives are rejected.
    site_bonus_usd: z.number().min(0).optional(),
});

// Admin-side "sponsored %" — a cost-accounting annotation, 0–100.
const sponsorshipSchema = z.object({
    sponsored_percentage: z
        .number()
        .min(0, "Sponsored % must be 0 or more")
        .max(100, "Sponsored % must be 100 or less"),
});

// Admin-side "creator paid his part" flag — a purely internal tracking
// annotation ("so we know if he paid or not"). Does NOT affect any money
// math (PnL / GGR / Leaderboard Cost).
const creatorPaidSchema = z.object({
    paid: z.boolean(),
});

// Admin-side "paid manually" annotation. Note is optional; backend trims/
// clears empty strings and also forces-clears the note when toggling off.
const manualPaymentSchema = z.object({
    paid_manually: z.boolean(),
    payout_note: z
        .string()
        .max(2000, "Note must be 2000 characters or less")
        .optional()
        .nullable(),
});

// Freeze a participant's prize claim — a wager-abuse hold that blocks the
// user from claiming while a review is open. Reason is required (recorded in
// the audit trail). User id is free-form text (matches the backend param),
// not a UUID, so it gets its own light validation.
const userIdSchema = z.string().trim().min(1, "User id is required");

const freezeClaimSchema = z.object({
    reason: z.string().trim().min(1, "Reason is required").max(500),
});

const unfreezeClaimSchema = z.object({
    release_reason: z.string().trim().max(500).optional().nullable(),
});

function toErrorMessage(err: unknown): string {
    if (err instanceof BackendApiError) {
        return err.message;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return "Unknown error";
}

function logAuditFailure(action: string, err: unknown): void {
    // Audit logging must not fail the operation — backend already committed.
    console.error(`[${action}] audit logging failed:`, err);
}

function revalidate(id: string): void {
    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${id}`);
    // The hub creator-detail "Affiliate Leaderboards" card reads through an
    // unstable_cache entry (120s TTL) which revalidatePath does NOT bust —
    // flush its tag so approvals/cancellations/etc. show immediately.
    revalidateTag("creator-leaderboards");
}

/**
 * Admin page access OR Creator Hub access — for the mutations reachable
 * from BOTH the admin pages and the hub dialogs (claim freeze/unfreeze +
 * leaderboard create). `requirePageAccess` REDIRECTS on denial, which
 * ejected a hub-toggle-only creator_manager out of the hub mid-dialog;
 * this throws instead so the dialog surfaces a toast. Fail-closed: admin
 * → page permission → `requireCreatorHubAccess` (throws on denial).
 */
async function requireLeaderboardActionAccess(
    unauthorizedMessage = "Not authorized to manage leaderboard claims.",
) {
    const session = await verifySession();
    if (sessionIsAdmin(session)) return session;

    const allowedPages = await getUserPermissions(session.userId);
    if (allowedPages.includes(PAGE_KEY)) return session;

    return requireCreatorHubAccess(unauthorizedMessage);
}

export async function createLeaderboard(
    input: z.infer<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
    // Hub-aware gate (freezeClaim precedent): the hub's Create Leaderboard
    // dialog calls this action, and the previous requirePageAccess redirect
    // ejected hub-only managers mid-dialog. Broadens NOTHING for non-hub
    // users; owner motha and page-permission holders pass exactly as before.
    const session = await requireLeaderboardActionAccess(
        "Not authorized to create leaderboards.",
    );
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    let created: LeaderboardAdminRow;
    try {
        created = await affiliateLeaderboardsApi.create(parsed.data, session.userId);
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_created",
            metadata: {
                leaderboard_id: created.id,
                creator_user_id: parsed.data.creator_user_id,
                site_bonus_usd: parsed.data.site_bonus_usd,
            },
        });
    } catch (err) {
        logAuditFailure("createLeaderboard", err);
    }

    revalidatePath(PAGE_KEY);
    revalidatePath(`/creators/${parsed.data.creator_user_id}`);
    revalidatePath(`/creator-hub/creators/${parsed.data.creator_user_id}`);
    // Tag flush — the hub creator-detail leaderboards card is
    // unstable_cache'd (120s); a freshly-created board must show at once.
    revalidateTag("creator-leaderboards");
    return { success: true, data: { id: created.id } };
}

export async function approveLeaderboard(id: string): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid id" };
    }
    await requireCapability(session, "__can_approve_leaderboard", "approve creator leaderboards");

    try {
        await affiliateLeaderboardsApi.approve(parsed.data, session.userId);
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_approved",
            metadata: { leaderboard_id: parsed.data },
        });
    } catch (err) {
        logAuditFailure("approveLeaderboard", err);
    }

    revalidate(parsed.data);
    return { success: true };
}

export async function rejectLeaderboard(
    id: string,
    input: { rejection_reason: string },
): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = rejectSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(session, "__can_approve_leaderboard", "reject creator leaderboards");

    try {
        await affiliateLeaderboardsApi.reject(parsedId.data, parsed.data, session.userId);
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_rejected",
            metadata: {
                leaderboard_id: parsedId.data,
                rejection_reason: parsed.data.rejection_reason,
            },
        });
    } catch (err) {
        logAuditFailure("rejectLeaderboard", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

export async function editLeaderboard(
    id: string,
    input: z.infer<typeof editSchema>,
): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = editSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(session, "__can_update_creator_deal", "edit creator leaderboards");

    // Snapshot the current state *before* mutating so the audit metadata can
    // record an exact diff. If this read fails, we still proceed with the edit
    // and log an audit event without before/after — the mutation is the
    // source-of-truth, audit detail is best-effort.
    let before: LeaderboardAdminRow | null = null;
    try {
        before = await affiliateLeaderboardsApi.get(parsedId.data);
    } catch (err) {
        logAuditFailure("editLeaderboard.snapshot", err);
    }

    let after: LeaderboardAdminRow;
    try {
        after = await affiliateLeaderboardsApi.edit(parsedId.data, parsed.data, session.userId);
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_edited",
            metadata: {
                leaderboard_id: parsedId.data,
                fields: Object.keys(parsed.data),
                ...(before ? { before: extractEditedFields(before, parsed.data) } : {}),
                after: extractEditedFields(after, parsed.data),
            },
        });
    } catch (err) {
        logAuditFailure("editLeaderboard", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

/**
 * Set the admin-side "sponsored %" annotation on a leaderboard.
 *
 * This is PURELY a cost-accounting input for the /creators
 * "Leaderboard Cost" KPI — it does NOT touch the backend leaderboard
 * (no prize change, no API call). Upserts the admin-DB row keyed by
 * leaderboard id. Editable for any leaderboard regardless of status,
 * since it's our own annotation, not a backend field.
 */
export async function setLeaderboardSponsorship(
    leaderboardId: string,
    sponsoredPercentage: number,
): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(leaderboardId);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = sponsorshipSchema.safeParse({
        sponsored_percentage: sponsoredPercentage,
    });
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(
        session,
        "__can_update_creator_deal",
        "edit creator leaderboards",
    );

    try {
        await adminDb.admin_leaderboard_sponsorship.upsert({
            where: { leaderboard_id: parsedId.data },
            create: {
                leaderboard_id: parsedId.data,
                sponsored_percentage: parsed.data.sponsored_percentage,
                set_by_admin_id: session.userId,
            },
            update: {
                sponsored_percentage: parsed.data.sponsored_percentage,
                set_by_admin_id: session.userId,
                updated_at: new Date(),
            },
        });
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_sponsorship_set",
            metadata: {
                leaderboard_id: parsedId.data,
                sponsored_percentage: parsed.data.sponsored_percentage,
            },
        });
    } catch (err) {
        logAuditFailure("setLeaderboardSponsorship", err);
    }

    revalidate(parsedId.data);
    // The /creators "Leaderboard Cost" KPI weights by this %, so it
    // must recompute too.
    revalidatePath("/creators");
    return { success: true };
}

/**
 * Toggle the admin-side "creator paid his part" flag on a leaderboard.
 *
 * PURELY an internal tracking flag — "just so we know if he paid or
 * not." It does NOT touch the backend leaderboard (no API call), any
 * balance/ledger, or ANY money math: PnL, GGR, and the /creators
 * Leaderboard Cost are all unaffected. Upserts the admin-DB row keyed
 * by leaderboard id; `paid_at` is stamped when flipped on and cleared
 * when flipped off. Editable for any leaderboard regardless of status,
 * since it's our own annotation, not a backend field. Admin-gated
 * identically to setLeaderboardSponsorship.
 */
export async function setLeaderboardCreatorPaid(
    leaderboardId: string,
    paid: boolean,
): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(leaderboardId);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = creatorPaidSchema.safeParse({ paid });
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(
        session,
        "__can_update_creator_deal",
        "edit creator leaderboards",
    );

    const paidAt = parsed.data.paid ? new Date() : null;

    try {
        await adminDb.admin_leaderboard_creator_paid.upsert({
            where: { leaderboard_id: parsedId.data },
            create: {
                leaderboard_id: parsedId.data,
                paid: parsed.data.paid,
                paid_at: paidAt,
                set_by_admin_id: session.userId,
            },
            update: {
                paid: parsed.data.paid,
                paid_at: paidAt,
                set_by_admin_id: session.userId,
                updated_at: new Date(),
            },
        });
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_creator_paid_set",
            metadata: {
                leaderboard_id: parsedId.data,
                paid: parsed.data.paid,
            },
        });
    } catch (err) {
        logAuditFailure("setLeaderboardCreatorPaid", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

/**
 * Toggle the "paid manually" flag and update the optional payout note on a
 * creator leaderboard. Annotation only — does not touch any balance, ledger,
 * or backend leaderboard state. Editable for any leaderboard regardless of
 * status, since it tracks an off-platform payout that an admin performed.
 */
export async function setLeaderboardManualPayment(
    leaderboardId: string,
    input: { paid_manually: boolean; payout_note?: string | null },
): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(leaderboardId);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = manualPaymentSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(
        session,
        "__can_update_creator_deal",
        "edit creator leaderboards",
    );

    try {
        await affiliateLeaderboardsApi.setManualPayment(
            parsedId.data,
            {
                paid_manually: parsed.data.paid_manually,
                payout_note: parsed.data.payout_note ?? null,
            },
            session.userId,
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_manual_payment_set",
            metadata: {
                leaderboard_id: parsedId.data,
                paid_manually: parsed.data.paid_manually,
                has_note: !!(parsed.data.payout_note && parsed.data.payout_note.trim().length > 0),
            },
        });
    } catch (err) {
        logAuditFailure("setLeaderboardManualPayment", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

export async function sponsorLeaderboard(
    id: string,
    input: { additional_bonus_usd: number },
): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = sponsorSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(session, "__can_update_creator_deal", "sponsor creator leaderboards");

    // Snapshot pre-sponsor totals so the audit shows exactly which pool the
    // delta was added to (and what the resulting total became).
    let before: Pick<LeaderboardAdminRow, "site_bonus_usd" | "total_prize_usd"> | null = null;
    try {
        const row = await affiliateLeaderboardsApi.get(parsedId.data);
        before = { site_bonus_usd: row.site_bonus_usd, total_prize_usd: row.total_prize_usd };
    } catch (err) {
        logAuditFailure("sponsorLeaderboard.snapshot", err);
    }

    let after: LeaderboardAdminRow;
    try {
        after = await affiliateLeaderboardsApi.sponsor(parsedId.data, parsed.data, session.userId);
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_sponsored",
            metadata: {
                leaderboard_id: parsedId.data,
                additional_bonus_usd: parsed.data.additional_bonus_usd,
                ...(before ? { before } : {}),
                after: {
                    site_bonus_usd: after.site_bonus_usd,
                    total_prize_usd: after.total_prize_usd,
                },
            },
        });
    } catch (err) {
        logAuditFailure("sponsorLeaderboard", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

const hardDeleteSchema = z.object({
    confirmation_id: z.string().uuid("Confirmation id must be the leaderboard's UUID"),
});

export async function hardDeleteLeaderboard(
    id: string,
    input: { confirmation_id: string },
): Promise<ActionResult<{ refund_amount_usd: string; previous_status: string }>> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsed = hardDeleteSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    // Local guard so a typo in the dialog can't reach the backend with a
    // valid-looking-but-wrong UUID. Backend also enforces the same check.
    if (parsed.data.confirmation_id !== parsedId.data) {
        return {
            success: false,
            error: "Confirmation id must exactly match the leaderboard id",
        };
    }
    await requireCapability(session, "__can_approve_leaderboard", "hard-delete creator leaderboards");

    let result;
    try {
        result = await affiliateLeaderboardsApi.hardDelete(
            parsedId.data,
            { confirmation_id: parsed.data.confirmation_id },
            session.userId,
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_hard_deleted",
            metadata: {
                leaderboard_id: parsedId.data,
                previous_status: result.previous_status,
                refund_amount_usd: result.refund_amount_usd,
            },
        });
    } catch (err) {
        logAuditFailure("hardDeleteLeaderboard", err);
    }

    // The detail page no longer exists post-delete, but revalidating the list
    // is essential so the row disappears immediately on return.
    revalidatePath(PAGE_KEY);
    return {
        success: true,
        data: {
            refund_amount_usd: result.refund_amount_usd,
            previous_status: result.previous_status,
        },
    };
}

export async function cancelLeaderboard(id: string): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    await requireCapability(session, "__can_approve_leaderboard", "cancel creator leaderboards");

    try {
        await affiliateLeaderboardsApi.cancel(parsedId.data, session.userId);
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_cancelled",
            metadata: { leaderboard_id: parsedId.data },
        });
    } catch (err) {
        logAuditFailure("cancelLeaderboard", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

/**
 * Freeze a participant's prize claim for a leaderboard. Places a hold so the
 * user cannot claim while a wager-abuse review is open — works at any point in
 * the leaderboard's life and is scoped to this leaderboard only. The backend
 * returns 409 if the prize was already claimed or the user is already frozen;
 * that message is surfaced to the caller as-is.
 */
export async function freezeClaim(
    leaderboardId: string,
    userId: string,
    input: { reason: string },
): Promise<ActionResult> {
    const session = await requireLeaderboardActionAccess();
    const parsedId = idSchema.safeParse(leaderboardId);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsedUserId = userIdSchema.safeParse(userId);
    if (!parsedUserId.success) {
        return { success: false, error: parsedUserId.error.issues[0]?.message ?? "Invalid user id" };
    }
    const parsed = freezeClaimSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(session, "__can_approve_leaderboard", "freeze affiliate leaderboard claims");

    try {
        await affiliateLeaderboardsApi.freezeClaim(
            parsedId.data,
            parsedUserId.data,
            { reason: parsed.data.reason },
            session.userId,
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_claim_frozen",
            targetUserId: parsedUserId.data,
            metadata: {
                leaderboard_id: parsedId.data,
                user_id: parsedUserId.data,
                reason: parsed.data.reason,
            },
        });
    } catch (err) {
        logAuditFailure("freezeClaim", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

/**
 * Lift the active freeze on a participant's prize claim, re-enabling the
 * claim. The hold row is kept (released_at set) for the audit trail. The
 * backend returns 404 if there is no active hold. An optional release reason
 * is recorded in the audit trail.
 */
export async function unfreezeClaim(
    leaderboardId: string,
    userId: string,
    input: { release_reason?: string | null },
): Promise<ActionResult> {
    const session = await requireLeaderboardActionAccess();
    const parsedId = idSchema.safeParse(leaderboardId);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }
    const parsedUserId = userIdSchema.safeParse(userId);
    if (!parsedUserId.success) {
        return { success: false, error: parsedUserId.error.issues[0]?.message ?? "Invalid user id" };
    }
    const parsed = unfreezeClaimSchema.safeParse(input);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    await requireCapability(session, "__can_approve_leaderboard", "unfreeze affiliate leaderboard claims");

    const releaseReason = parsed.data.release_reason?.trim() || null;

    try {
        await affiliateLeaderboardsApi.unfreezeClaim(
            parsedId.data,
            parsedUserId.data,
            { release_reason: releaseReason },
            session.userId,
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_claim_unfrozen",
            targetUserId: parsedUserId.data,
            metadata: {
                leaderboard_id: parsedId.data,
                user_id: parsedUserId.data,
                ...(releaseReason ? { release_reason: releaseReason } : {}),
            },
        });
    } catch (err) {
        logAuditFailure("unfreezeClaim", err);
    }

    revalidate(parsedId.data);
    return { success: true };
}

/**
 * Project a LeaderboardAdminRow down to only the fields that were touched in
 * this edit, so before/after audit metadata stays minimal and meaningful
 * instead of dumping the entire row.
 */
function extractEditedFields(
    row: LeaderboardAdminRow,
    edited: EditInput,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (edited.title !== undefined) out.title = row.title;
    if (edited.affiliate_codes !== undefined) out.affiliate_codes = row.affiliate_codes;
    if (edited.co_creator_user_ids !== undefined) out.co_creator_user_ids = row.co_creator_user_ids;
    if (edited.start_date !== undefined) out.start_date = row.start_date;
    if (edited.end_date !== undefined) out.end_date = row.end_date;
    if (edited.prize_tiers !== undefined) out.prize_tiers = row.prize_tiers;
    return out;
}
