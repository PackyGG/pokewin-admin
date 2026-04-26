"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { backendApi } from "@/lib/backend-api/client";
import { BackendApiError } from "@/lib/backend-api/errors";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

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

export async function approveLeaderboard(id: string): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) {
        return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid id" };
    }

    try {
        await backendApi.post(`/admin/affiliate-leaderboards/${parsed.data}/approve`, {}, {
            headers: { "x-admin-user-id": session.userId },
        });
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
        // Don't fail the whole operation if audit fails — backend already committed.
        // eslint-disable-next-line no-console
        console.error("[approveLeaderboard] audit logging failed:", err);
    }

    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${parsed.data}`);
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
        await backendApi.post(
            `/admin/affiliate-leaderboards/${parsedId.data}/reject`,
            parsed.data,
            { headers: { "x-admin-user-id": session.userId } },
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_rejected",
            metadata: { leaderboard_id: parsedId.data, rejection_reason: parsed.data.rejection_reason },
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[rejectLeaderboard] audit logging failed:", err);
    }

    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${parsedId.data}`);
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

    try {
        await backendApi.patch(
            `/admin/affiliate-leaderboards/${parsedId.data}`,
            parsed.data,
            { headers: { "x-admin-user-id": session.userId } },
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_edited",
            metadata: { leaderboard_id: parsedId.data, fields: Object.keys(parsed.data) },
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[editLeaderboard] audit logging failed:", err);
    }

    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${parsedId.data}`);
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

    try {
        await backendApi.post(
            `/admin/affiliate-leaderboards/${parsedId.data}/sponsor`,
            parsed.data,
            { headers: { "x-admin-user-id": session.userId } },
        );
    } catch (err) {
        return { success: false, error: toErrorMessage(err) };
    }

    try {
        await createAdminAuditEvent({
            adminUserId: session.userId,
            eventType: "affiliate_leaderboard_sponsored",
            metadata: { leaderboard_id: parsedId.data, additional_bonus_usd: parsed.data.additional_bonus_usd },
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[sponsorLeaderboard] audit logging failed:", err);
    }

    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${parsedId.data}`);
    return { success: true };
}

export async function cancelLeaderboard(id: string): Promise<ActionResult> {
    const session = await requirePageAccess(PAGE_KEY);
    const parsedId = idSchema.safeParse(id);
    if (!parsedId.success) {
        return { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id" };
    }

    try {
        await backendApi.post(
            `/admin/affiliate-leaderboards/${parsedId.data}/cancel`,
            {},
            { headers: { "x-admin-user-id": session.userId } },
        );
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
        // eslint-disable-next-line no-console
        console.error("[cancelLeaderboard] audit logging failed:", err);
    }

    revalidatePath(PAGE_KEY);
    revalidatePath(`${PAGE_KEY}/${parsedId.data}`);
    return { success: true };
}
