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
} from "@/lib/backend-api/announcements";
import {
  validateAnnouncementPayload,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_TYPE_MAX,
  type AnnouncementPayloadDraft,
} from "@/lib/announcement-payload";

export type CreateAnnouncementFormInput = {
  title: string;
  body: string | null;
  category: AnnouncementCreateCategory;
  audienceRoles: AnnouncementAudienceRole[] | null;
  type?: string | null;
  endsAt?: string | null;
  /** Link / image / button metadata — validated here against the same rules
   * the backend enforces, so a bad value fails with a readable message
   * instead of an opaque 422. */
  payload?: Partial<AnnouncementPayloadDraft>;
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
  if (title.length > ANNOUNCEMENT_TITLE_MAX) {
    return {
      success: false,
      error: `Title must be ${ANNOUNCEMENT_TITLE_MAX} characters or less`,
    };
  }

  const body = input.body?.trim() || null;
  if (body && body.length > ANNOUNCEMENT_BODY_MAX) {
    return {
      success: false,
      error: `Message must be ${ANNOUNCEMENT_BODY_MAX} characters or less`,
    };
  }

  const type = input.type?.trim() || DEFAULT_ANNOUNCEMENT_TYPE;
  if (type.length > ANNOUNCEMENT_TYPE_MAX) {
    return {
      success: false,
      error: `Type must be ${ANNOUNCEMENT_TYPE_MAX} characters or less`,
    };
  }

  const payloadCheck = validateAnnouncementPayload(input.payload);
  if (!payloadCheck.ok) return { success: false, error: payloadCheck.error };
  const payload = payloadCheck.payload;

  try {
    const created = await createAnnouncement({
      category: input.category,
      type,
      title,
      body,
      payload,
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
        type,
        audienceRoles: input.audienceRoles,
        // Link / image / button actually broadcast — part of the audit trail
        // because a bad link reaches every user on the site.
        payload: payload ?? null,
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
