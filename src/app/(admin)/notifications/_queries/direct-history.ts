import "server-only";

import { desc, eq, inArray } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { admin_audit_events, admin_users } from "@/lib/db-schema/admin/schema";

/**
 * History of per-user notifications sent from this admin.
 *
 * There is no backend endpoint that lists admin-sent notifications — the
 * personal feed is queried per-user, by that user. What we DO own is the
 * audit trail every send already writes, so that is the source of truth here:
 * `admin_audit_events` in the ADMIN DB (never the game DB — no cross-DB join;
 * the sender's username is resolved through the modelled `admin_user`
 * relation, which lives in the same database).
 *
 * Index: `admin_audit_events_event_type_created_idx (event_type,
 * created_at DESC)` covers `event_type IN (...) ORDER BY created_at DESC`
 * exactly, so this is an index scan, not a table scan.
 *
 * Grouping: a bulk campaign writes one audit row PER CHUNK (17 rows for the
 * ~16.5k-user case). Seventeen near-identical lines is not a history, so
 * chunks of the same campaign are folded into one entry with summed counts
 * and a unioned unknown-user list. Single sends stay as individual entries.
 */

const EVENT_TYPES = [
  "user_notification_sent",
  "user_notifications_bulk_sent",
  "reward_campaign_chunk_sent",
];

/** Audit rows scanned before folding. Bounded so a long-running admin can't
 * drag an unbounded set into the request; the folded output is capped lower
 * still. A 1000-chunk campaign would be 1000 rows — well inside this. */
const SCAN_LIMIT = 300;
const RESULT_LIMIT = 40;

export type DirectNotificationHistoryEntry = {
  id: string;
  kind: "single" | "bulk" | "reward";
  sentAt: string;
  /** Earliest chunk time for a bulk campaign; same as sentAt for a single. */
  startedAt: string;
  adminUsername: string | null;
  env: string | null;
  category: string | null;
  type: string | null;
  /** Bulk only. */
  campaign: string | null;
  /** Bulk only — how many chunk requests this campaign took. */
  chunks: number;
  /** Single only. */
  targetUserId: string | null;
  requested: number;
  created: number;
  deduped: number;
  unknownUsers: string[];
  /** Representative payload — the single send's own, or a bulk sample item's. */
  samplePayload: Record<string, unknown> | null;
  /** Reward campaigns only — new codes minted, and the money they carry. */
  codesMinted: number;
  valueUsd: number | null;
  /**
   * Exact notification identities retained for read analytics. Older bulk
   * audit rows predate this field, so `trackingComplete` must stay separate:
   * an empty array can be complete, while a missing array is unknown.
   */
  trackingItems: DirectNotificationTrackingItem[];
  trackingComplete: boolean;
};

export type DirectNotificationTrackingItem = {
  userId: string;
  dedupeKey: string;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const asPayload = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function asTrackingItems(
  value: unknown,
): DirectNotificationTrackingItem[] | null {
  if (!Array.isArray(value)) return null;

  const items: DirectNotificationTrackingItem[] = [];
  for (const item of value) {
    const row = asPayload(item);
    const userId = str(row?.userId);
    const dedupeKey = str(row?.dedupeKey);
    if (!userId || !dedupeKey) return null;
    items.push({ userId, dedupeKey });
  }
  return items;
}

export async function getDirectNotificationHistory(): Promise<
  DirectNotificationHistoryEntry[]
> {
  const rows = await adminDrizzle
    .select({
      id: admin_audit_events.id,
      event_type: admin_audit_events.event_type,
      target_user_id: admin_audit_events.target_user_id,
      created_at: admin_audit_events.created_at,
      metadata: admin_audit_events.metadata,
      adminUsername: admin_users.username,
    })
    .from(admin_audit_events)
    .leftJoin(admin_users, eq(admin_users.id, admin_audit_events.admin_user_id))
    .where(inArray(admin_audit_events.event_type, EVENT_TYPES))
    .orderBy(desc(admin_audit_events.created_at))
    .limit(SCAN_LIMIT);

  const entries: DirectNotificationHistoryEntry[] = [];
  // Campaign key → index into `entries`, so later chunks fold into the first
  // (most recent) entry we saw for that campaign.
  const byCampaign = new Map<string, number>();

  for (const row of rows) {
    const meta = asPayload(row.metadata) ?? {};
    const sentAt = new Date(row.created_at).toISOString();
    const adminUsername = row.adminUsername;
    const category = str(meta.category);
    const type = str(meta.type);
    const env = str(meta.env);

    if (row.event_type === "user_notification_sent") {
      const dedupeKey = str(meta.dedupeKey);
      const explicitTrackingItems = asTrackingItems(meta.trackingItems);
      const trackingItems =
        explicitTrackingItems ??
        (row.target_user_id && dedupeKey
          ? [{ userId: row.target_user_id, dedupeKey }]
          : []);
      entries.push({
        id: row.id,
        kind: "single",
        sentAt,
        startedAt: sentAt,
        adminUsername,
        env,
        category,
        type,
        campaign: null,
        chunks: 1,
        targetUserId: row.target_user_id,
        // The single endpoint can't report created-vs-deduped, so counts stay
        // at zero rather than inventing a number the API never gave us.
        requested: 1,
        created: 0,
        deduped: 0,
        unknownUsers: [],
        samplePayload: asPayload(meta.payload),
        codesMinted: 0,
        valueUsd: null,
        trackingItems,
        trackingComplete:
          explicitTrackingItems !== null ||
          Boolean(row.target_user_id && dedupeKey),
      });
      continue;
    }

    const isReward = row.event_type === "reward_campaign_chunk_sent";
    const campaign = str(meta.campaign);
    // Same campaign re-run with a different type/category is a different send.
    const key = `${campaign ?? row.id}|${type ?? ""}|${category ?? ""}|${env ?? ""}`;
    const unknown = Array.isArray(meta.unknownUsers)
      ? meta.unknownUsers.filter((u): u is string => typeof u === "string")
      : [];
    const sampleItem = asPayload(meta.sampleItem);
    const trackingItems = asTrackingItems(meta.trackingItems);

    const existingIndex = byCampaign.get(key);
    if (existingIndex === undefined) {
      byCampaign.set(key, entries.length);
      entries.push({
        id: row.id,
        kind: isReward ? "reward" : "bulk",
        sentAt,
        startedAt: sentAt,
        adminUsername,
        env,
        // A reward chunk has no free-form category/type — the flow fixes both.
        category: isReward ? "rewards" : category,
        type: isReward ? "promo_code_granted" : type,
        campaign,
        chunks: 1,
        targetUserId: null,
        requested: num(meta.requested),
        created: num(meta.created),
        deduped: num(meta.deduped),
        unknownUsers: unknown,
        samplePayload: sampleItem ? asPayload(sampleItem.payload) : null,
        codesMinted: isReward ? num(meta.codesMinted) : 0,
        valueUsd: isReward ? num(meta.valueUsd) : null,
        trackingItems: trackingItems ?? [],
        trackingComplete: trackingItems !== null,
      });
      continue;
    }

    const entry = entries[existingIndex];
    entry.chunks += 1;
    entry.requested += num(meta.requested);
    entry.created += num(meta.created);
    entry.deduped += num(meta.deduped);
    // Rows arrive newest-first, so each fold pushes the start time earlier.
    entry.startedAt = sentAt;
    if (unknown.length > 0) {
      entry.unknownUsers = [...new Set([...entry.unknownUsers, ...unknown])];
    }
    if (!entry.samplePayload && sampleItem) {
      entry.samplePayload = asPayload(sampleItem.payload);
    }
    if (isReward) {
      entry.codesMinted += num(meta.codesMinted);
      // Per-user amount, not a sum — every chunk of one campaign carries the
      // same value, so folding must not add them up.
      if (entry.valueUsd === null) entry.valueUsd = num(meta.valueUsd);
    }
    entry.trackingComplete =
      entry.trackingComplete && trackingItems !== null;
    if (trackingItems) {
      entry.trackingItems.push(...trackingItems);
    }
  }

  return entries.slice(0, RESULT_LIMIT);
}
