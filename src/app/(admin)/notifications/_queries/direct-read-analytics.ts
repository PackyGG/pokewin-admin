import "server-only";

import { sql } from "drizzle-orm";

import { readDrizzleForEnv } from "@/lib/db";
import type { DbEnv } from "@/lib/db-env";
import type {
  DirectNotificationHistoryEntry,
  DirectNotificationTrackingItem,
} from "./direct-history";

/**
 * One maximum-size direct campaign. This keeps the request bounded even when
 * the 40-row history includes several 25k-recipient sends. Newest complete
 * sends win; older entries clearly report that their analytics were deferred.
 */
const MAX_TRACKED_REFS_PER_RENDER = 25_000;

export type DirectNotificationReadStat =
  | {
      status: "exact";
      delivered: number;
      read: number;
    }
  | {
      status: "not-tracked" | "different-environment" | "deferred";
      delivered: null;
      read: null;
    };

type TrackedRow = {
  group_id: string;
  user_id: string;
  dedupe_key: string;
};

type AggregateRow = {
  group_id: string;
  delivered: number;
  read: number;
};

function uniqueTrackingItems(
  items: DirectNotificationTrackingItem[],
): DirectNotificationTrackingItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.userId}\u0000${item.dedupeKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve exact read totals through `(user_id, dedupe_key)`, the same pair
 * protected by `notifications_user_dedupe_uq`.
 *
 * The recipient identities come from the ADMIN audit trail, then this second
 * read runs independently against the selected MAIN mirror. There is no
 * cross-database join and no MAIN mutation.
 */
export async function getDirectNotificationReadStats(
  entries: DirectNotificationHistoryEntry[],
  activeEnv: DbEnv,
): Promise<Record<string, DirectNotificationReadStat>> {
  const stats: Record<string, DirectNotificationReadStat> = {};
  const trackedRows: TrackedRow[] = [];
  let remaining = MAX_TRACKED_REFS_PER_RENDER;

  for (const entry of entries) {
    if (entry.env !== activeEnv) {
      stats[entry.id] = {
        status: "different-environment",
        delivered: null,
        read: null,
      };
      continue;
    }

    if (!entry.trackingComplete || entry.trackingItems.length === 0) {
      stats[entry.id] = {
        status: "not-tracked",
        delivered: null,
        read: null,
      };
      continue;
    }

    const items = uniqueTrackingItems(entry.trackingItems);
    if (items.length > remaining) {
      stats[entry.id] = {
        status: "deferred",
        delivered: null,
        read: null,
      };
      continue;
    }

    remaining -= items.length;
    stats[entry.id] = { status: "exact", delivered: 0, read: 0 };
    trackedRows.push(
      ...items.map((item) => ({
        group_id: entry.id,
        user_id: item.userId,
        dedupe_key: item.dedupeKey,
      })),
    );
  }

  if (trackedRows.length === 0) return stats;

  const db = readDrizzleForEnv(activeEnv);
  const result = await db.execute<AggregateRow>(sql`
    WITH tracked AS (
      SELECT DISTINCT group_id, user_id, dedupe_key
      FROM jsonb_to_recordset(${JSON.stringify(trackedRows)}::jsonb)
        AS item(group_id text, user_id text, dedupe_key text)
    )
    SELECT
      tracked.group_id,
      count(notification.id)::int AS delivered,
      count(notification.read_at)::int AS read
    FROM tracked
    LEFT JOIN LATERAL (
      SELECT notifications.id, notifications.read_at
      FROM notifications
      WHERE notifications.user_id = tracked.user_id
        AND notifications.dedupe_key = tracked.dedupe_key
      LIMIT 1
    ) AS notification ON true
    GROUP BY tracked.group_id
  `);

  for (const row of result.rows) {
    stats[row.group_id] = {
      status: "exact",
      delivered: Number(row.delivered),
      read: Number(row.read),
    };
  }

  return stats;
}
