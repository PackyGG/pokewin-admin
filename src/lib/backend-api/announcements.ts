import "server-only";

import { desc, inArray, sql } from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import {
  announcement_reads,
  announcements,
} from "@/lib/db-schema/main/schema";
import { backendApi } from "./client";
import type { AnnouncementPayload } from "@/lib/announcement-payload";

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
type AnnouncementCategory = "transaction" | "rewards" | "system" | "news";

export type AnnouncementCreateCategory = "news" | "system";

export type AnnouncementAudienceRole = "user" | "support" | "admin" | "creator";

/** `{ url, image_url, cta_label }` — shape + validation rules live in
 * `@/lib/announcement-payload` (importable from client components too, which
 * this server-only module is not). */
;

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

async function getAnnouncementsFromPostgres(
  params?: { limit?: number; offset?: number },
): Promise<ListSuccess<Announcement>> {
  const db = await getReadDrizzleDb();
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(params?.limit ?? 25)),
  );
  const offset = Math.max(0, Math.trunc(params?.offset ?? 0));
  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(announcements)
      .orderBy(desc(announcements.created_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(announcements),
  ]);
  const total = totalRows[0]?.count ?? 0;
  const data: Announcement[] = rows.map((row) => ({
    ...row,
    payload: row.payload as AnnouncementPayload,
    audience_roles:
      row.audience_roles as AnnouncementAudienceRole[] | null,
  }));
  return {
    success: true,
    data,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
    },
  };
}

export const getAnnouncements = async (
  params?: { limit?: number; offset?: number },
): Promise<ListSuccess<Announcement>> => {
  try {
    return await backendApi.get<ListSuccess<Announcement>>(
      "/admin/announcements",
      {
        query: { limit: params?.limit, offset: params?.offset },
      },
    );
  } catch (error) {
    console.warn(
      "[announcements-api] backend list read failed; using PostgreSQL",
      error,
    );
    return getAnnouncementsFromPostgres(params);
  }
};

/**
 * Exact per-announcement "marked read" totals from the site.
 *
 * This deliberately does not call the number an impression or an open:
 * `announcement_reads` proves that the site marked the announcement read,
 * but it does not prove how long it was visible or whether its CTA was
 * clicked. The composite primary key starts with `announcement_id`, so this
 * bounded page-sized aggregate is index-served.
 */
export async function getAnnouncementReadCounts(
  announcementIds: string[],
): Promise<Record<string, number>> {
  const ids = [...new Set(announcementIds)].slice(0, 100);
  if (ids.length === 0) return {};

  const db = await getReadDrizzleDb();
  const rows = await db
    .select({
      announcementId: announcement_reads.announcement_id,
      count: sql<number>`count(*)::int`,
    })
    .from(announcement_reads)
    .where(inArray(announcement_reads.announcement_id, ids))
    .groupBy(announcement_reads.announcement_id);

  return Object.fromEntries(
    rows.map((row) => [row.announcementId, row.count]),
  );
}

export const createAnnouncement = (input: CreateAnnouncementInput) =>
  backendApi
    .post<Success<Announcement>>("/admin/announcements", input)
    .then((r) => r.data);

export const revokeAnnouncement = (id: string) =>
  backendApi.delete<{ success: boolean; message: string }>(
    `/admin/announcements/${encodeURIComponent(id)}`,
  );
