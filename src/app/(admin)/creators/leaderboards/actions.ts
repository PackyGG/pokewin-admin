"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
    affiliateLeaderboardsApi,
    type EditInput,
    type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { BackendApiError } from "@/lib/backend-api/errors";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getDb } from "@/lib/db";

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
        .min(1, "At least one prize tier is required"),
});

const editSchema = z.object({
    title: z.string().trim().min(1).max(100).optional(),
    affiliate_codes: z.array(z.string()).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    prize_tiers: z
        .array(
            z.object({
                position: z.number().int().positive(),
                prize_amount_usd: z.number().positive(),
            }),
        )
        .min(1)
        .optional(),
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
    // eslint-disable-next-line no-console
    console.error(`[${action}] audit logging failed:`, err);
}

function revalidate(id: string): void {
    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${id}`);
}

export async function createLeaderboard(
    input: z.infer<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
    const session = await requirePageAccess(PAGE_KEY);
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
    return { success: true, data: { id: created.id } };
}

export async function approveLeaderboard(id: string): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid id" };
    }

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

export async function cancelLeaderboard(id: string): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }

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
    if (edited.start_date !== undefined) out.start_date = row.start_date;
    if (edited.end_date !== undefined) out.end_date = row.end_date;
    if (edited.prize_tiers !== undefined) out.prize_tiers = row.prize_tiers;
    return out;
}
