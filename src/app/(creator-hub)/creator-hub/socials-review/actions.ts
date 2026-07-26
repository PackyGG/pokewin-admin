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
