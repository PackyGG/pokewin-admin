"use server";

import { revalidatePath } from "next/cache";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createAnnouncement,
  revokeAnnouncement,
  type AnnouncementAudienceRole,
  type AnnouncementCreateCategory,
  type AnnouncementPayload,
} from "@/lib/backend-api/announcements";

export type CreateAnnouncementFormInput = {
  title: string;
  body: string | null;
  category: AnnouncementCreateCategory;
  audienceRoles: AnnouncementAudienceRole[] | null;
  type?: string | null;
  endsAt?: string | null;
  payload?: AnnouncementPayload;
};

/** Default `type` for a manually-created admin announcement — the backend
 * requires a type string, but the simple create form doesn't ask for one. */
const DEFAULT_ANNOUNCEMENT_TYPE = "admin_announcement";

export async function createAnnouncementAction(
  input: CreateAnnouncementFormInput,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(session, "__can_manage_announcements", "create announcements");

  const title = input.title.trim();
  if (!title) return { success: false, error: "Title is required" };

  try {
    const created = await createAnnouncement({
      category: input.category,
      type: input.type?.trim() || DEFAULT_ANNOUNCEMENT_TYPE,
      title,
      body: input.body?.trim() || null,
      payload: input.payload,
      audience_roles: input.audienceRoles,
      ends_at: input.endsAt || null,
      created_by: session.userId,
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "announcement_created",
      metadata: {
        announcementId: created.id,
        title,
        category: input.category,
        audienceRoles: input.audienceRoles,
      },
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to create announcement",
    };
  }

  revalidatePath("/notifications");
  return { success: true };
}

export async function revokeAnnouncementAction(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/notifications");
  await requireCapability(session, "__can_manage_announcements", "revoke announcements");

  try {
    await revokeAnnouncement(id);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to revoke announcement",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "announcement_revoked",
    metadata: { announcementId: id },
  });

  revalidatePath("/notifications");
  return { success: true };
}
