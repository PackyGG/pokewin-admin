import "server-only";

import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getReadDrizzleDb } from "@/lib/db";
import {
  admin_audit_events,
  admin_users,
} from "@/lib/db-schema/admin/schema";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { logError } from "@/lib/errors/logger";
import { isQueryTimeoutError, withTimeout } from "@/lib/errors/safe-query";

/**
 * ANTIFRAUD AUDIT LOG — what a STAFF MEMBER did in the Fraud workspace.
 *
 * The workspace also keeps a security-boundary log
 * (`antifraud_security_audit_events`, see `./security-audit.ts`): page views,
 * denials, rate-limit hits and every automated `antifraud-monitor` ingest.
 * That table exists for the gate machinery (rate limiting, idempotency,
 * denial forensics) — it is NOT an operator audit trail, and presenting it as
 * one buried the handful of real staff decisions under system noise.
 *
 * This module is the operator trail: `admin_audit_events` in the ADMIN DB,
 * scoped to the Fraud workspace's own event vocabulary. One row = one staff
 * decision (ban, case verdict, KYC review, refund batch, blocklist change,
 * risk-config edit, alert routing). No system actors, no page views.
 *
 * Indexes: `admin_audit_events_event_type_idx` covers the scope predicate,
 * `admin_audit_events_created_at_idx` the ordering,
 * `admin_audit_events_admin_user_id_idx` the actor filter (all present in the
 * checked-in Admin Drizzle schema).
 */

export type AntifraudAuditCategory =
  | "enforcement"
  | "cases"
  | "kyc"
  | "refunds"
  | "blocklists"
  | "risk"
  | "alerts";

export type AntifraudAuditTone = "danger" | "warn" | "good" | "neutral";

type EventDefinition = {
  label: string;
  category: AntifraudAuditCategory;
  tone: AntifraudAuditTone;
  /**
   * True when the event type is ALSO written outside the Fraud workspace
   * (the same `account_banned` type comes from /users too). Those rows only
   * belong here when the writing action tagged itself — see `scopePredicate`.
   */
  shared?: true;
};

export const ANTIFRAUD_AUDIT_CATEGORY_LABELS: Record<
  AntifraudAuditCategory,
  string
> = {
  enforcement: "Enforcement",
  cases: "Cases",
  kyc: "KYC",
  refunds: "Refunds",
  blocklists: "Blocklists",
  risk: "Risk config",
  alerts: "Alerts",
};

export const ANTIFRAUD_AUDIT_EVENTS: Record<string, EventDefinition> = {
  // Enforcement
  account_banned: {
    label: "Account banned",
    category: "enforcement",
    tone: "danger",
    shared: true,
  },
  account_unbanned: {
    label: "Account unbanned",
    category: "enforcement",
    tone: "good",
    shared: true,
  },
  antifraud_withdrawals_locked: {
    label: "Withdrawals locked",
    category: "enforcement",
    tone: "danger",
  },
  antifraud_withdrawal_reviewed: {
    label: "Withdrawal reviewed",
    category: "enforcement",
    tone: "neutral",
  },
  antifraud_fiat_deposit_reviewed: {
    label: "Fiat deposit reviewed",
    category: "enforcement",
    tone: "neutral",
  },

  // Cases
  antifraud_review_opened: {
    label: "Case opened",
    category: "cases",
    tone: "warn",
  },
  antifraud_review_status_changed: {
    label: "Case decision",
    category: "cases",
    tone: "neutral",
  },
  antifraud_review_postponed: {
    label: "Case postponed",
    category: "cases",
    tone: "warn",
  },
  antifraud_monitor_case_decision: {
    label: "Monitor case decision",
    category: "cases",
    tone: "neutral",
  },

  // KYC
  user_kyc_required: {
    label: "KYC required",
    category: "kyc",
    tone: "warn",
    shared: true,
  },
  user_kyc_reviewed: {
    label: "KYC reviewed",
    category: "kyc",
    tone: "neutral",
    shared: true,
  },

  // Refunds
  whop_refund_batch_created: {
    label: "Refund batch created",
    category: "refunds",
    tone: "warn",
  },
  whop_refund_batch_completed: {
    label: "Refund batch completed",
    category: "refunds",
    tone: "neutral",
  },
  whop_refund_account_recovered: {
    label: "Refund account recovered",
    category: "refunds",
    tone: "good",
  },
  whop_refund_accounts_recovered: {
    label: "Refund accounts recovered",
    category: "refunds",
    tone: "good",
  },
  whop_refund_account_recovery_failed: {
    label: "Refund recovery failed",
    category: "refunds",
    tone: "danger",
  },

  // Blocklists
  antifraud_identifier_blocklist_created: {
    label: "Identifier blocked",
    category: "blocklists",
    tone: "danger",
  },
  antifraud_identifier_blocklist_reactivated: {
    label: "Identifier block re-enabled",
    category: "blocklists",
    tone: "danger",
  },
  antifraud_identifier_blocklist_disabled: {
    label: "Identifier block lifted",
    category: "blocklists",
    tone: "good",
  },
  fiat_email_domain_blacklisted: {
    label: "Email domain blocked",
    category: "blocklists",
    tone: "danger",
  },
  fiat_email_domain_blacklist_enabled: {
    label: "Email domain block re-enabled",
    category: "blocklists",
    tone: "danger",
  },
  fiat_email_domain_blacklist_disabled: {
    label: "Email domain block lifted",
    category: "blocklists",
    tone: "good",
  },
  antifraud_risky_location_created: {
    label: "Risky location added",
    category: "blocklists",
    tone: "warn",
  },
  antifraud_risky_location_updated: {
    label: "Risky location updated",
    category: "blocklists",
    tone: "neutral",
  },

  // Risk config
  antifraud_score_weight_updated: {
    label: "Risk weight updated",
    category: "risk",
    tone: "neutral",
  },
  antifraud_analysis_rule_updated: {
    label: "Analysis rule updated",
    category: "risk",
    tone: "neutral",
  },
  antifraud_flow_created: {
    label: "Flow created",
    category: "risk",
    tone: "neutral",
  },
  antifraud_flow_updated: {
    label: "Flow updated",
    category: "risk",
    tone: "neutral",
  },

  // Alerts
  discord_notification_event_created: {
    label: "Alert event created",
    category: "alerts",
    tone: "neutral",
  },
  discord_notification_route_upserted: {
    label: "Alert route saved",
    category: "alerts",
    tone: "neutral",
  },
  discord_notification_route_toggled: {
    label: "Alert route toggled",
    category: "alerts",
    tone: "neutral",
  },
  discord_notification_route_deleted: {
    label: "Alert route deleted",
    category: "alerts",
    tone: "warn",
  },
  discord_notification_channel_routes_replaced: {
    label: "Channel routes replaced",
    category: "alerts",
    tone: "neutral",
  },
  discord_notification_channel_creation_queued: {
    label: "Alert channel queued",
    category: "alerts",
    tone: "neutral",
  },
};

const ALL_EVENT_TYPES = Object.keys(ANTIFRAUD_AUDIT_EVENTS);
const EXCLUSIVE_EVENT_TYPES = ALL_EVENT_TYPES.filter(
  (type) => !ANTIFRAUD_AUDIT_EVENTS[type].shared,
);
const SHARED_EVENT_TYPES = ALL_EVENT_TYPES.filter(
  (type) => ANTIFRAUD_AUDIT_EVENTS[type].shared,
);

export function antifraudAuditEventsFor(
  category: AntifraudAuditCategory,
): string[] {
  return ALL_EVENT_TYPES.filter(
    (type) => ANTIFRAUD_AUDIT_EVENTS[type].category === category,
  );
}

/**
 * Rows written from THIS workspace only.
 *
 * A shared event type (`account_banned`, `user_kyc_*`) is also produced by the
 * main admin surfaces, so it counts as a Fraud action only when the writing
 * action tagged it: `metadata.source` starts with `antifraud`, or the row
 * carries a `reviewId` (the reviews workspace quick-ban wrote those before the
 * source tag existed).
 */
function scopePredicate(): SQL {
  return sql`(
    ${admin_audit_events.event_type} = ANY(${pgArrayParam(EXCLUSIVE_EVENT_TYPES)}::text[])
    OR (
      ${admin_audit_events.event_type} = ANY(${pgArrayParam(SHARED_EVENT_TYPES)}::text[])
      AND (
        ${admin_audit_events.metadata} ->> 'source' LIKE 'antifraud%'
        OR jsonb_exists(${admin_audit_events.metadata}, 'reviewId')
      )
    )
  )`;
}

export type AntifraudAuditRow = {
  id: string;
  eventType: string;
  label: string;
  category: AntifraudAuditCategory;
  tone: AntifraudAuditTone;
  actorUsername: string | null;
  actorRole: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AntifraudAuditPage = {
  rows: AntifraudAuditRow[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  /** Distinct staff members who acted in the last 30 days. */
  activeStaff: number;
  /** Staff actions in the last 24 hours (unfiltered scope). */
  last24h: number;
  /** Staff who have ever acted in the scope — feeds the actor filter. */
  actors: { id: string; username: string }[];
};

const PER_PAGE = 25;
/** Bounded wall clock for the MAIN-DB display hydration of target usernames. */
const MAIN_DB_TIMEOUT_MS = 6_000;

export type AntifraudAuditFilters = {
  page?: number;
  category?: AntifraudAuditCategory;
  event?: string;
  actorId?: string;
  search?: string;
};

export async function listAntifraudStaffAudit(
  filters: AntifraudAuditFilters,
): Promise<AntifraudAuditPage> {
  const page = Math.max(1, Math.min(filters.page ?? 1, 10_000));
  const conditions: SQL[] = [scopePredicate()];

  if (filters.event && ANTIFRAUD_AUDIT_EVENTS[filters.event]) {
    conditions.push(eq(admin_audit_events.event_type, filters.event));
  } else if (filters.category) {
    conditions.push(
      sql`${admin_audit_events.event_type} = ANY(${pgArrayParam(
        antifraudAuditEventsFor(filters.category),
      )}::text[])`,
    );
  }
  if (filters.actorId) {
    conditions.push(eq(admin_audit_events.admin_user_id, filters.actorId));
  }

  const search = filters.search?.trim().slice(0, 100);
  if (search) {
    const targetIds = await resolveTargetIds(search);
    conditions.push(
      targetIds.length > 0
        ? sql`${admin_audit_events.target_user_id} = ANY(${pgArrayParam(targetIds)}::text[])`
        : sql`FALSE`,
    );
  }

  const where = and(...conditions)!;

  const [rows, total, summary, actors] = await Promise.all([
    adminDrizzle
      .select({
        id: admin_audit_events.id,
        event_type: admin_audit_events.event_type,
        target_user_id: admin_audit_events.target_user_id,
        metadata: admin_audit_events.metadata,
        created_at: admin_audit_events.created_at,
        actor_username: admin_users.username,
        actor_role: admin_users.role,
      })
      .from(admin_audit_events)
      .leftJoin(
        admin_users,
        eq(admin_users.id, admin_audit_events.admin_user_id),
      )
      .where(where)
      .orderBy(
        desc(admin_audit_events.created_at),
        desc(admin_audit_events.id),
      )
      .limit(PER_PAGE)
      .offset((page - 1) * PER_PAGE),
    adminDrizzle
      .select({ value: count() })
      .from(admin_audit_events)
      .where(where)
      .then((result) => result[0]?.value ?? 0),
    adminDrizzle
      .execute<{ active_staff: string; last_24h: string }>(sql`
        SELECT
          count(DISTINCT admin_user_id) FILTER (
            WHERE created_at >= now() - interval '30 days'
          )::text AS active_staff,
          count(*) FILTER (
            WHERE created_at >= now() - interval '24 hours'
          )::text AS last_24h
        FROM ${admin_audit_events}
        WHERE ${scopePredicate()}
          AND ${admin_audit_events.created_at} >= now() - interval '30 days'
      `)
      .then((result) => result.rows[0] ?? null),
    adminDrizzle
      .execute<{ id: string; username: string }>(sql`
        SELECT DISTINCT
          ${admin_users.id}::text AS id,
          ${admin_users.username} AS username
        FROM ${admin_audit_events}
        JOIN ${admin_users}
          ON ${admin_users.id} = ${admin_audit_events.admin_user_id}
        WHERE ${scopePredicate()}
        ORDER BY ${admin_users.username} ASC
        LIMIT 100
      `)
      .then((result) => result.rows),
  ]);

  const targetUsernames = await hydrateTargetUsernames(
    [...new Set(rows.map((row) => row.target_user_id).filter(Boolean))] as string[],
  );

  return {
    rows: rows.map((row) => {
      const definition = ANTIFRAUD_AUDIT_EVENTS[row.event_type];
      return {
        id: row.id,
        eventType: row.event_type,
        label: definition?.label ?? row.event_type,
        category: definition?.category ?? "enforcement",
        tone: definition?.tone ?? "neutral",
        actorUsername: row.actor_username,
        actorRole: row.actor_role,
        targetUserId: row.target_user_id,
        targetUsername: row.target_user_id
          ? targetUsernames.get(row.target_user_id) ?? null
          : null,
        metadata:
          row.metadata && typeof row.metadata === "object"
            ? (row.metadata as Record<string, unknown>)
            : null,
        createdAt: new Date(row.created_at).toISOString(),
      };
    }),
    total,
    page,
    perPage: PER_PAGE,
    pages: Math.max(1, Math.ceil(total / PER_PAGE)),
    activeStaff: Number(summary?.active_staff ?? 0),
    last24h: Number(summary?.last_24h ?? 0),
    actors,
  };
}

/**
 * Search term → main-DB user ids. A raw id passes straight through; anything
 * else resolves through a bounded username/email lookup. A slow or
 * unavailable main DB degrades to "no match" instead of hanging the page.
 */
async function resolveTargetIds(search: string): Promise<string[]> {
  const ids = new Set<string>();
  // An id-looking term stays a candidate even when the username lookup also
  // matches — pasting a raw user id must never come back empty.
  if (/^[0-9a-zA-Z_-]{16,}$/.test(search)) ids.add(search);
  try {
    const db = await getReadDrizzleDb();
    const escaped = search.replace(/[\\%_]/g, "\\$&");
    const result = await withTimeout(
      () =>
        db.execute<{ id: string }>(sql`
          SELECT id
          FROM "user"
          WHERE username ILIKE ${`%${escaped}%`} ESCAPE '\'
             OR email ILIKE ${`%${escaped}%`} ESCAPE '\'
          LIMIT 50
        `),
      MAIN_DB_TIMEOUT_MS,
    );
    for (const row of result.rows) ids.add(row.id);
  } catch (err) {
    logError(
      "antifraud.staffAudit.resolveTarget",
      isQueryTimeoutError(err)
        ? "target search timed out"
        : "target search failed",
      err,
    );
  }
  return [...ids];
}

/** Display-only hydration; a main-DB failure leaves raw ids on screen. */
async function hydrateTargetUsernames(
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  try {
    const db = await getReadDrizzleDb();
    const result = await withTimeout(
      () =>
        db.execute<{ id: string; username: string | null; email: string | null }>(sql`
          SELECT id, username, email
          FROM "user"
          WHERE id = ANY(${pgArrayParam(ids)}::text[])
        `),
      MAIN_DB_TIMEOUT_MS,
    );
    for (const row of result.rows) {
      map.set(row.id, row.username ?? row.email ?? row.id);
    }
  } catch (err) {
    logError(
      "antifraud.staffAudit.hydrate",
      isQueryTimeoutError(err)
        ? "target username hydration timed out"
        : "target username hydration failed",
      err,
    );
  }
  return map;
}
