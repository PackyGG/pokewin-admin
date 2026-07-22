import "server-only";

import { backendApi } from "./client";

/**
 * Announcements admin API — the GLOBAL broadcast side of the notification
 * system (distinct from the per-user `notifications` feed, which has no
 * admin-facing endpoint today). One row reaches every user whose role
 * matches `audience_roles` (or everyone, when omitted/null) while the
 * current time falls in `[starts_at, ends_at)` — fan-out-on-read, so
 * creating one is instant regardless of user count.
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/announcements.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/** Matches the backend's `notification_category` enum. Create only allows
 * `news` / `system` — `transaction` / `rewards` are reserved for the
 * per-user notify() path, not broadcasts (backend-enforced). */
export type AnnouncementCategory = "transaction" | "rewards" | "system" | "news";

export type AnnouncementCreateCategory = "news" | "system";

export type AnnouncementAudienceRole = "user" | "support" | "admin" | "creator";

export type AnnouncementPayload = {
  url?: string | null;
  image_url?: string | null;
  cta_label?: string | null;
};

export type Announcement = {
  id: string;
  category: AnnouncementCategory;
  type: string;
  title: string;
  body: string | null;
  payload: AnnouncementPayload;
  audience_roles: AnnouncementAudienceRole[] | null;
  starts_at: string;
  ends_at: string | null;
  created_by: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type CreateAnnouncementInput = {
  category: AnnouncementCreateCategory;
  type: string;
  title: string;
  body?: string | null;
  payload?: AnnouncementPayload;
  audience_roles?: AnnouncementAudienceRole[] | null;
  starts_at?: string;
  ends_at?: string | null;
  created_by?: string;
};

type Success<T> = { success: boolean; data: T };
type ListSuccess<T> = {
  success: boolean;
  data: T[];
  meta: { total: number; limit: number; offset: number; hasMore: boolean };
};

export const getAnnouncements = (params?: { limit?: number; offset?: number }) =>
  backendApi.get<ListSuccess<Announcement>>("/admin/announcements", {
    query: { limit: params?.limit, offset: params?.offset },
  });

export const createAnnouncement = (input: CreateAnnouncementInput) =>
  backendApi
    .post<Success<Announcement>>("/admin/announcements", input)
    .then((r) => r.data);

export const revokeAnnouncement = (id: string) =>
  backendApi.delete<{ success: boolean; message: string }>(
    `/admin/announcements/${encodeURIComponent(id)}`,
  );
