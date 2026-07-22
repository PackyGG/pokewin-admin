import "server-only";

import { adminDb } from "@/lib/admin-db";

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

const EVENT_TYPES = ["user_notification_sent", "user_notifications_bulk_sent"];

/** Audit rows scanned before folding. Bounded so a long-running admin can't
 * drag an unbounded set into the request; the folded output is capped lower
 * still. A 1000-chunk campaign would be 1000 rows — well inside this. */
const SCAN_LIMIT = 300;
const RESULT_LIMIT = 40;

export type DirectNotificationHistoryEntry = {
  id: string;
  kind: "single" | "bulk";
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
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

const asPayload = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

export async function getDirectNotificationHistory(): Promise<
  DirectNotificationHistoryEntry[]
> {
  const rows = await adminDb.admin_audit_events.findMany({
    where: { event_type: { in: EVENT_TYPES } },
    orderBy: { created_at: "desc" },
    take: SCAN_LIMIT,
    select: {
      id: true,
      event_type: true,
      target_user_id: true,
      created_at: true,
      metadata: true,
      admin_user: { select: { username: true } },
    },
  });

  const entries: DirectNotificationHistoryEntry[] = [];
  // Campaign key → index into `entries`, so later chunks fold into the first
  // (most recent) entry we saw for that campaign.
  const byCampaign = new Map<string, number>();

  for (const row of rows) {
    const meta = asPayload(row.metadata) ?? {};
    const sentAt = row.created_at.toISOString();
    const adminUsername = row.admin_user?.username ?? null;
    const category = str(meta.category);
    const type = str(meta.type);
    const env = str(meta.env);

    if (row.event_type === "user_notification_sent") {
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
      });
      continue;
    }

    const campaign = str(meta.campaign);
    // Same campaign re-run with a different type/category is a different send.
    const key = `${campaign ?? row.id}|${type ?? ""}|${category ?? ""}|${env ?? ""}`;
    const unknown = Array.isArray(meta.unknownUsers)
      ? meta.unknownUsers.filter((u): u is string => typeof u === "string")
      : [];
    const sampleItem = asPayload(meta.sampleItem);

    const existingIndex = byCampaign.get(key);
    if (existingIndex === undefined) {
      byCampaign.set(key, entries.length);
      entries.push({
        id: row.id,
        kind: "bulk",
        sentAt,
        startedAt: sentAt,
        adminUsername,
        env,
        category,
        type,
        campaign,
        chunks: 1,
        targetUserId: null,
        requested: num(meta.requested),
        created: num(meta.created),
        deduped: num(meta.deduped),
        unknownUsers: unknown,
        samplePayload: sampleItem ? asPayload(sampleItem.payload) : null,
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
  }

  return entries.slice(0, RESULT_LIMIT);
}
