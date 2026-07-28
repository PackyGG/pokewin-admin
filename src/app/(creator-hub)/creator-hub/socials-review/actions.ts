"use server";

import { revalidatePath } from "next/cache";

import { verifySession } from "@/lib/dal";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import { requireCapability } from "@/lib/require-capability";
import { BackendApiError, creatorsApi } from "@/lib/backend-api";

/**
 * Server actions for Creator Hub → Socials Review.
 *
 * Mirrors the admin `/creators/socials` approve/reject mutations but gates
 * on the Hub access rule (`canAccessCreatorHub`) instead of page-route
 * access, then narrows with the same `__can_review_creator_social`
 * capability. Writes go through the backend API; audit rows land in the
 * ADMIN DB. Revalidates both Hub and legacy admin surfaces.
 */

const toActionError = (err: unknown): Error => {
  if (err instanceof BackendApiError) {
    return new Error(err.code ? `${err.message} (${err.code})` : err.message);
  }
  return err instanceof Error ? err : new Error("Unknown backend error");
};

async function requireCreatorHubReviewAccess(): Promise<{
  userId: string;
  session: { userId: string; role: string; roles?: string[] };
}> {
  const session = await verifySession();

  const user = (
    await adminDrizzle
      .select({
        username: admin_users.username,
        is_active: admin_users.is_active,
      })
      .from(admin_users)
      .where(eq(admin_users.id, session.userId))
      .limit(1)
  )[0];
  if (!user?.is_active) {
    throw new Error("Not authorized to review creator socials.");
  }

  const settings = await getCreatorHubAccessSettings();
  const allowed = canAccessCreatorHub(
    { username: user.username, role: session.role, roles: session.roles },
    settings,
  );
  if (!allowed) {
    throw new Error("Not authorized to review creator socials.");
  }

  await requireCapability(
    session,
    "__can_review_creator_social",
    "review creator socials",
  );

  return { userId: session.userId, session };
}

export async function approveCreatorSocial(socialId: string) {
  const { userId } = await requireCreatorHubReviewAccess();

  try {
    const result = await creatorsApi.approveSocial(socialId);

    await createAdminAuditEvent({
      adminUserId: userId,
      eventType: "creator_social_approved",
      targetUserId: result.user_id,
      metadata: {
        via: "creator_hub_socials_review",
        social_id: result.id,
        platform: result.platform,
        username: result.username,
      },
    });

    revalidatePath(`/creator-hub/creators/${result.user_id}`);
    revalidatePath("/creator-hub/socials-review");
    revalidatePath(`/creators/${result.user_id}`);
    revalidatePath("/creators/socials");
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

export async function rejectCreatorSocial(
  socialId: string,
  options: { reason?: string } = {},
) {
  const { userId } = await requireCreatorHubReviewAccess();

  try {
    const result = await creatorsApi.rejectSocial(socialId, options.reason);

    await createAdminAuditEvent({
      adminUserId: userId,
      eventType: "creator_social_rejected",
      targetUserId: result.user_id,
      metadata: {
        via: "creator_hub_socials_review",
        social_id: result.id,
        platform: result.platform,
        username: result.username,
        reason: options.reason ?? null,
      },
    });

    revalidatePath(`/creator-hub/creators/${result.user_id}`);
    revalidatePath("/creator-hub/socials-review");
    revalidatePath(`/creators/${result.user_id}`);
    revalidatePath("/creators/socials");
    return result;
  } catch (err) {
    throw toActionError(err);
  }
}

/** One queue page worth — the bulk bar can never select more than a page. */
const BULK_MAX_IDS = 50;

export type BulkReviewResult = {
  succeeded: string[];
  failed: { id: string; message: string }[];
};

/**
 * Bulk approve/reject — the SAME per-item backend calls and per-item audit
 * events as the single-row actions, behind the SAME access gate
 * (`requireCreatorHubReviewAccess` = active admin user + Hub access +
 * `__can_review_creator_social` capability), checked once up front. Items run
 * sequentially; one failure never aborts the rest — per-id outcomes are
 * returned so the client can restore only the rows that failed. Paths are
 * revalidated once at the end.
 */
export async function bulkReviewCreatorSocials(input: {
  ids: string[];
  action: "approve" | "reject";
  reason?: string;
}): Promise<BulkReviewResult> {
  const { userId } = await requireCreatorHubReviewAccess();

  const ids = [...new Set(input.ids)].filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  if (ids.length === 0) throw new Error("No submissions selected.");
  if (ids.length > BULK_MAX_IDS) {
    throw new Error(`Too many submissions selected (max ${BULK_MAX_IDS}).`);
  }
  const reason = input.reason?.trim().slice(0, 500) || undefined;

  const succeeded: string[] = [];
  const failed: { id: string; message: string }[] = [];
  const touchedUserIds = new Set<string>();

  for (const id of ids) {
    try {
      const result =
        input.action === "approve"
          ? await creatorsApi.approveSocial(id)
          : await creatorsApi.rejectSocial(id, reason);

      await createAdminAuditEvent({
        adminUserId: userId,
        eventType:
          input.action === "approve"
            ? "creator_social_approved"
            : "creator_social_rejected",
        targetUserId: result.user_id,
        metadata: {
          via: "creator_hub_socials_review",
          bulk: true,
          social_id: result.id,
          platform: result.platform,
          username: result.username,
          ...(input.action === "reject" ? { reason: reason ?? null } : {}),
        },
      });

      touchedUserIds.add(result.user_id);
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, message: toActionError(err).message });
    }
  }

  for (const targetUserId of touchedUserIds) {
    revalidatePath(`/creator-hub/creators/${targetUserId}`);
    revalidatePath(`/creators/${targetUserId}`);
  }
  revalidatePath("/creator-hub/socials-review");
  revalidatePath("/creators/socials");

  return { succeeded, failed };
}
