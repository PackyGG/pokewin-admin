/**
 * Queries that surface OTHER users who share identity signals with a
 * given user. Powers the "Shared IPs" and "Shared Fingerprints" tables
 * on the Trust tab of /users/[id].
 *
 * Each row represents a single OTHER user that overlaps on at least one
 * IP (or fingerprint). We aggregate across the fingerprints table so a
 * single link row can carry:
 *   - how many distinct IPs (or visitor_ids) they share,
 *   - how many total overlapping events were recorded,
 *   - the most recent time the linked user was seen with a shared
 *     identity event.
 *
 * Kept small and read-only — no caching here because these tables are
 * only rendered on the detail page and we want them to reflect the
 * current state.
 */

import { db } from "@/lib/db";

// The type moved to ./shared-identity-types so client components can
// import it without pulling Prisma into the browser bundle. Re-exported
// here for backward compat.
export type { SharedIdentityUser } from "./shared-identity-types";
import type { SharedIdentityUser } from "./shared-identity-types";

type Row = {
  user_id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  is_banned: boolean;
  is_locked: boolean;
  shared_count: bigint;
  total_events: bigint;
  last_seen_at: Date | null;
  sample_values: string[] | null;
};

/**
 * OTHER users that share at least one IP address with `userId`. Sorted
 * by shared IP count desc, then last-seen desc. Limited to 50 rows —
 * more than that on the detail page is noise, and the list query
 * (`sharedIpCount`) already conveys the scale.
 */
export async function getSharedIpUsers(
  userId: string,
): Promise<SharedIdentityUser[]> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT
      u.id                              AS user_id,
      u.username                        AS username,
      u.email                           AS email,
      u.image                           AS image,
      u.role::text                      AS role,
      u.is_banned                       AS is_banned,
      u.is_locked                       AS is_locked,
      COUNT(DISTINCT f2.ip)::bigint     AS shared_count,
      COUNT(*)::bigint                  AS total_events,
      MAX(f2.created_at)                AS last_seen_at,
      (ARRAY_AGG(DISTINCT host(f2.ip)) FILTER (WHERE f2.ip IS NOT NULL))[1:5] AS sample_values
    FROM fingerprints f1
    JOIN fingerprints f2
      ON f1.ip = f2.ip
     AND f2.user_id IS NOT NULL
     AND f2.user_id <> ${userId}
    JOIN "user" u ON u.id = f2.user_id
    WHERE f1.user_id = ${userId} AND f1.ip IS NOT NULL
    GROUP BY u.id, u.username, u.email, u.image, u.role, u.is_banned, u.is_locked
    ORDER BY shared_count DESC, last_seen_at DESC
    LIMIT 50
  `;

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    email: r.email,
    image: r.image,
    role: r.role,
    isBanned: r.is_banned,
    isLocked: r.is_locked,
    sharedCount: Number(r.shared_count),
    totalEvents: Number(r.total_events),
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    sampleValues: r.sample_values ?? [],
  }));
}

/**
 * OTHER users that share at least one device fingerprint (visitor_id)
 * with `userId`. Fingerprints are a stronger identity signal than IPs.
 */
export async function getSharedFingerprintUsers(
  userId: string,
): Promise<SharedIdentityUser[]> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT
      u.id                                     AS user_id,
      u.username                               AS username,
      u.email                                  AS email,
      u.image                                  AS image,
      u.role::text                             AS role,
      u.is_banned                              AS is_banned,
      u.is_locked                              AS is_locked,
      COUNT(DISTINCT f2.visitor_id)::bigint    AS shared_count,
      COUNT(*)::bigint                         AS total_events,
      MAX(f2.created_at)                       AS last_seen_at,
      (ARRAY_AGG(DISTINCT f2.visitor_id))[1:5] AS sample_values
    FROM fingerprints f1
    JOIN fingerprints f2
      ON f1.visitor_id = f2.visitor_id
     AND f2.user_id IS NOT NULL
     AND f2.user_id <> ${userId}
    JOIN "user" u ON u.id = f2.user_id
    WHERE f1.user_id = ${userId}
    GROUP BY u.id, u.username, u.email, u.image, u.role, u.is_banned, u.is_locked
    ORDER BY shared_count DESC, last_seen_at DESC
    LIMIT 50
  `;

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    email: r.email,
    image: r.image,
    role: r.role,
    isBanned: r.is_banned,
    isLocked: r.is_locked,
    sharedCount: Number(r.shared_count),
    totalEvents: Number(r.total_events),
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    sampleValues: r.sample_values ?? [],
  }));
}
