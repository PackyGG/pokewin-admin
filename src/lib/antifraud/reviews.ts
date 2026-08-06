import { pgArrayParam } from "@/lib/drizzle-array-param";
import "server-only";

import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { antifraud_review_notes, antifraud_reviews, antifraud_signals } from "@/lib/db-schema/admin/schema";
import { user, user_feature_locks } from "@/lib/db-schema/main/schema";
import { getReadDrizzleDb } from "@/lib/db";
import { isPostgresError } from "@/lib/postgres-errors";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { getLocalDayBounds } from "@/lib/timezone/core";
import { getAdminDisplayTimeZone } from "@/lib/timezone/server";
import { toNumber } from "@/lib/utils/decimal";
import {
  loadAdminIdentities,
  type AdminIdentity,
} from "./admin-identities";
import {
  OPEN_REVIEW_STATUSES,
  type ReviewStatus,
  type ReviewSeverity,
} from "./constants";
import {
  isUsefulReviewSignalTrailEntry,
  NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS,
  withoutNonActionableRewardEnrollmentSignals,
} from "./signal-display";
import {
  loadReviewWorkflows,
  reviewQueueCondition,
  type ReviewQueueState,
  type ReviewWorkflow,
} from "./review-workflow";

const REVIEW_QUEUE_STORAGE_STATUSES = [
  ...OPEN_REVIEW_STATUSES,
  "escalated",
] as const;

/**
 * The account-review queue.
 *
 * A review is the fraud team's WORKING RECORD about one player account: why it
 * was pulled, who is on it, and what the verdict was. It deliberately does NOT
 * act on the account — banning, adjusting a balance or wiping an account still
 * goes through the existing, separately-audited admin surfaces. That keeps this
 * workspace additive: the MAIN (prod game) DB is never written from here, and
 * the reviewed player is carried as a loose `target_user_id` string.
 */

// The status vocabulary lives in the isomorphic `./constants` module so Client
// Components (the queue dialogs, the case controls) can import it WITHOUT
// dragging this server-only file — and
// therefore server-only database code — into the browser bundle. Re-exported here so every
// existing server-side import keeps working unchanged.
export {
  REVIEW_STATUSES,
  OPEN_REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_COLORS,
  REVIEW_SEVERITIES,
  REVIEW_SEVERITY_LABELS,
  REVIEW_SEVERITY_COLORS,
  isReviewStatus,
  isReviewSeverity,
  type ReviewStatus,
  type ReviewSeverity,
} from "./constants";

// ─── Shapes ───────────────────────────────────────────────────────────────

export type ReviewRow = {
  id: string;
  targetUserId: string;
  targetUsername: string | null;
  status: string;
  severity: string;
  source: string;
  riskScore: number | null;
  reason: string;
  signals: string[];
  assignedTo: string | null;
  openedBy: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ReviewListItem = ReviewRow & {
  assignee: AdminIdentity | null;
  opener: AdminIdentity | null;
  workflow: ReviewWorkflow | null;
};

export type ReviewNote = {
  id: string;
  kind: string;
  body: string;
  adminUserId: string | null;
  author: AdminIdentity | null;
  createdAt: Date;
};

function isMissingRelationError(error: unknown): boolean {
  return isPostgresError(error, "42P01");
}

function toRow(row: {
  id: string;
  target_user_id: string;
  target_username: string | null;
  status: string;
  severity: string;
  source: string;
  risk_score: number | null;
  reason: string;
  signals: string[];
  assigned_to: string | null;
  opened_by: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): ReviewRow {
  return {
    id: row.id,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username,
    status: row.status === "escalated" ? "in_review" : row.status,
    severity: row.severity,
    source: row.source,
    riskScore: row.risk_score,
    reason: row.reason,
    signals: withoutNonActionableRewardEnrollmentSignals(row.signals),
    assignedTo: row.assigned_to,
    openedBy: row.opened_by,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────

export type ReviewFilters = {
  /** Omit for the default "still needs work" set. "all" for everything. */
  status?: ReviewStatus | "all" | "unresolved";
  /** Operational queue tab. Defaults to high-priority work in the page. */
  queue?: ReviewQueueState;
  /** Active postponement state. False keeps normal tabs free of postponed work. */
  postponed?: boolean;
  /** Restrict the queue to the selected risk bands. */
  severities?: readonly ReviewSeverity[];
  /** Put critical cases ahead of high cases across every page. */
  severityFirst?: boolean;
  /** Limit to cases assigned to this admin. */
  assignedTo?: string;
  /** User ids owned by another operational queue, such as KYC. */
  excludedTargetUserIds?: readonly string[];
  /**
   * PREFIX match on the denormalized username / player id / reason — see
   * {@link buildReviewConditions} for why this is not a substring search.
   */
  search?: string;
  limit?: number;
};

/**
 * Predicates shared by the queue list and its COUNT.
 *
 * Index coverage, stated honestly (the queue indexes on `antifraud_reviews`
 * include `(status, created_at DESC)`, `(assigned_to, created_at DESC)`,
 * `(target_user_id)` and `(created_at DESC, id DESC)`):
 *
 *   • status / assigned-to / bare list — served by one of those indexes.
 *   • search — each prefix ILIKE arm is covered by the pg_trgm GIN indexes
 *     installed by `20260726_antifraud_review_search_indexes.sql`; exact
 *     player ids can additionally use `antifraud_reviews_target_idx`. The same
 *     predicates feed the COUNT, so it does not fall back to an unindexed
 *     chronological walk. Search intentionally remains prefix-only: a middle
 *     fragment is less useful to analysts and creates much larger bitmap sets.
 */
function buildReviewConditions(filters: ReviewFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.status === "all") {
    // no status predicate
  } else if (filters.status && filters.status !== "unresolved") {
    conditions.push(eq(antifraud_reviews.status, filters.status));
  } else {
    conditions.push(
      inArray(antifraud_reviews.status, [...REVIEW_QUEUE_STORAGE_STATUSES]),
    );
  }

  if (filters.assignedTo) conditions.push(eq(antifraud_reviews.assigned_to, filters.assignedTo));
  if (filters.queue) conditions.push(reviewQueueCondition(filters.queue));
  if (filters.postponed === true) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM antifraud_review_workflow AS postponed
      WHERE postponed.review_id = ${antifraud_reviews.id}
        AND postponed.postponed_until > now()
    )`);
  } else if (filters.postponed === false) {
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM antifraud_review_workflow AS postponed
      WHERE postponed.review_id = ${antifraud_reviews.id}
        AND postponed.postponed_until > now()
    )`);
  }
  if (filters.severities?.length) {
    conditions.push(inArray(antifraud_reviews.severity, [...filters.severities]));
  }

  if (filters.excludedTargetUserIds?.length) {
    conditions.push(sql`
      NOT (
        ${antifraud_reviews.target_user_id} =
        ANY(${pgArrayParam(filters.excludedTargetUserIds)}::text[])
      )
    `);
  }

  const term = filters.search?.trim();
  if (term) {
    const prefix = `${term}%`;
    conditions.push(or(
      // Exact ids use the btree; every prefix arm below uses its trigram GIN.
      eq(antifraud_reviews.target_user_id, term),
      ilike(antifraud_reviews.target_username, prefix),
      ilike(antifraud_reviews.target_user_id, prefix),
      ilike(antifraud_reviews.reason, prefix),
    )!);
  }

  return conditions;
}

/**
 * Flat list, newest first. Used by surfaces that want a fixed handful of
 * cases (the overview's "needs work" strip). The paginated queue uses
 * {@link listReviewPage} instead — a bare `limit` silently hides everything
 * past it, which is fine for a preview strip and wrong for the queue.
 */
export async function listReviews(
  filters: ReviewFilters = {},
): Promise<ReviewListItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 300);
  try {
    const conditions = buildReviewConditions(filters);

    const rows = await adminDrizzle.select().from(antifraud_reviews)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(antifraud_reviews.created_at)).limit(limit);

    return await attachIdentities(rows);
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listReviews failed:", err);
    }
    return [];
  }
}

async function attachIdentities(
  rows: (typeof antifraud_reviews.$inferSelect)[],
): Promise<ReviewListItem[]> {
  // Independent reads — the workflow lookup does not need the identities.
  // Awaiting them in sequence put a second full round-trip on the hottest
  // path in the workspace (every queue page and every case dialog).
  const [identities, workflows] = await Promise.all([
    loadAdminIdentities(rows.flatMap((r) => [r.assigned_to, r.opened_by])),
    loadReviewWorkflows(rows.map((row) => row.id)),
  ]);
  return rows.map((row) => ({
    ...toRow(row),
    assignee: row.assigned_to ? identities.get(row.assigned_to) ?? null : null,
    opener: row.opened_by ? identities.get(row.opened_by) ?? null : null,
    workflow: workflows.get(row.id) ?? null,
  }));
}

// ─── Keyset pagination ────────────────────────────────────────────────────

/** Rows per queue page. */
export const REVIEW_PAGE_SIZE = 50;

export type ReviewPage = {
  items: ReviewListItem[];
  /** Opaque cursor for the next (older) page, or null when this is the last. */
  nextCursor: string | null;
  /** Total rows matching the SAME predicates — not just this page. */
  total: number;
};

/**
 * Resolve a monitor-service case deep-link to its Account Review record.
 *
 * Index-backed since `drizzle/admin/migrations/20260806_antifraud_signals_monitor_case_idx.sql`:
 * two partial expression indexes on `payload ->> 'caseId'` /
 * `payload ->> 'monitorCaseId'`, both predicated on `review_id IS NOT NULL`
 * (which this query also asserts). Without them an unknown case id walked the
 * whole `antifraud_signals` table — there is no date bound here on purpose,
 * because a deep-link to an old case must still resolve.
 *
 * MUST NOT be awaited in the reviews page body: it is a dialog lookup, and
 * awaiting it above `PageHero` held the entire shell behind it. The page runs
 * it inside the dialog's own Suspense boundary.
 */
export async function getReviewIdForMonitorCase(
  monitorCaseId: string,
): Promise<string | null> {
  const result = await safeQueryOrNull(
    () =>
      adminDrizzle.execute<{ review_id: string }>(sql`
        SELECT signal.review_id::text
          FROM antifraud_signals signal
         WHERE signal.review_id IS NOT NULL
           AND (
             signal.payload ->> 'caseId' = ${monitorCaseId}
             OR signal.payload ->> 'monitorCaseId' = ${monitorCaseId}
           )
         ORDER BY signal.received_at DESC
         LIMIT 1
      `),
    "antifraud.review.monitor-case-link",
    3_000,
  );
  return result.data?.rows[0]?.review_id ?? null;
}

/**
 * Encode / decode the keyset cursor.
 *
 * The cursor is the last row's `(created_at, id)` tuple, base64url'd so it
 * survives a URL without escaping. It is NOT an offset: OFFSET re-scans and
 * skips every preceding row on each page, and shifts under concurrent inserts
 * (a new case arriving mid-paging makes one row repeat and another vanish).
 * The tuple comparison rides the
 * `antifraud_reviews_created_id_idx` ordering and is stable regardless of
 * what arrives while the analyst pages.
 */
function encodeReviewCursor(
  createdAt: string,
  id: string,
  severityRank?: number,
): string {
  const raw = severityRank == null
    ? `${createdAt}|${id}`
    : `${severityRank}|${createdAt}|${id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeReviewCursor(
  cursor: string | null | undefined,
): { createdAt: string; id: string; severityRank: number | null } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parts = raw.split("|");
    if (parts.length !== 2 && parts.length !== 3) return null;
    const [rankPart, createdAt, id] = parts.length === 3
      ? parts
      : [null, parts[0], parts[1]];
    // A hand-edited cursor must degrade to "first page", never to a query
    // error or an injected fragment (both values are still bound as params).
    if (!UUID_RE.test(id)) return null;
    if (Number.isNaN(new Date(createdAt).getTime())) return null;
    const severityRank = rankPart == null ? null : Number(rankPart);
    if (severityRank != null && (!Number.isInteger(severityRank) || severityRank < 0 || severityRank > 3)) {
      return null;
    }
    return { createdAt, id, severityRank };
  } catch {
    return null;
  }
}

/**
 * One page of the queue, plus the total for the header.
 *
 * Ordering is `(created_at DESC, id DESC)` — `created_at` alone is not a
 * unique key, so two cases created in the same microsecond could otherwise
 * straddle a page boundary and be shown twice or skipped. `id` is the
 * tiebreak that makes the keyset total.
 */
export async function listReviewPage(
  filters: ReviewFilters = {},
  cursor?: string | null,
): Promise<ReviewPage> {
  const pageSize = Math.min(Math.max(filters.limit ?? REVIEW_PAGE_SIZE, 1), 200);
  const conditions = buildReviewConditions(filters);
  const after = decodeReviewCursor(cursor);
  const severityRank = sql<number>`CASE ${antifraud_reviews.severity}
    WHEN 'critical' THEN 3
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 1
    ELSE 0
  END`;

  const pageConditions = [...conditions];
  if (after) {
    if (filters.severityFirst && after.severityRank != null) {
      pageConditions.push(sql`(
        ${severityRank}, ${antifraud_reviews.created_at}, ${antifraud_reviews.id}
      ) < (
        ${after.severityRank}, ${after.createdAt}::timestamptz, ${after.id}::uuid
      )`);
    } else {
      pageConditions.push(
        sql`(${antifraud_reviews.created_at}, ${antifraud_reviews.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
  }

  const [rows, totals] = await Promise.all([
    adminDrizzle.select().from(antifraud_reviews)
      .where(pageConditions.length ? and(...pageConditions) : undefined)
      .orderBy(
        ...(filters.severityFirst ? [desc(severityRank)] : []),
        desc(antifraud_reviews.created_at),
        desc(antifraud_reviews.id),
      )
      // One extra row is the "is there another page?" probe — cheaper and
      // race-free compared with comparing the count against the offset.
      .limit(pageSize + 1),
    adminDrizzle.select({ total: sql<string>`count(*)` })
      .from(antifraud_reviews)
      .where(conditions.length ? and(...conditions) : undefined),
  ]);

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    items: await attachIdentities(pageRows),
    nextCursor:
      hasMore && last
        ? encodeReviewCursor(
            last.created_at,
            last.id,
            filters.severityFirst
              ? last.severity === "critical"
                ? 3
                : last.severity === "high"
                  ? 2
                  : last.severity === "medium"
                    ? 1
                    : 0
              : undefined,
          )
        : null,
    total: Number(totals[0]?.total ?? 0),
  };
}

export type ReviewDetail = {
  review: ReviewRow;
  activeLocks: string[];
  financialFacts: {
    fiatDepositsUsd: number;
    cryptoDepositsUsd: number;
    wageredUsd: number;
  } | null;
  workflow: ReviewWorkflow | null;
  assignee: AdminIdentity | null;
  opener: AdminIdentity | null;
  resolver: AdminIdentity | null;
  account: {
    email: string | null;
    country: string | null;
    countryCode: string | null;
  } | null;
  notes: ReviewNote[];
  /** Other signals that arrived for the same account. */
  relatedSignals: {
    id: string;
    kind: string;
    severity: string;
    summary: string;
    /**
     * Running case score *after* this signal, not the signal's own weight.
     * Once a case is capped every later row reads the same number, which is
     * why the workspace ranks on `scoreDelta` instead.
     */
    riskScore: number | null;
    /**
     * Points this single event added, from the monitor's delivery payload.
     * `null` for producers that do not score per event (fiat, withdrawal).
     */
    scoreDelta: number | null;
    receivedAt: Date;
  }[];
};

/** Reads the per-event score contribution out of a signal payload. */
function signalScoreDelta(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as Record<string, unknown>).scoreDelta;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Why this is a three-way result and not `ReviewDetail | null`:
 *
 * A single `null` conflates "this case id does not exist" with "the admin DB
 * did not answer". The caller turns the first into a 404, which meant that
 * during an admin-DB outage every case in the workspace rendered as
 * "case not found" — the analyst is told their data is gone when in fact the
 * database is down, and nothing reaches the error boundary that would say so.
 */
export type ReviewDetailResult =
  | { kind: "ok"; detail: ReviewDetail }
  | { kind: "not_found" }
  | { kind: "failed"; error: string };

/**
 * Timeout for the case-detail reads. These are the only reads in this
 * workspace that used to run unbounded: a hung admin-DB connection blocked the
 * segment until the platform killed the whole request instead of degrading.
 */
export const REVIEW_DETAIL_TIMEOUT_MS = 10_000;

export async function getReviewDetail(
  reviewId: string,
): Promise<ReviewDetailResult> {
  // Read 1 — the case itself. `error` set ⇒ the query failed; `data` null with
  // no error ⇒ the id genuinely has no row.
  const head = await safeQueryOrNull(
    async () => {
      const [row] = await adminDrizzle.select().from(antifraud_reviews)
        .where(eq(antifraud_reviews.id, reviewId)).limit(1);
      return row ?? null;
    },
    "antifraud.review-detail",
    REVIEW_DETAIL_TIMEOUT_MS,
  );
  if (head.error) return { kind: "failed", error: head.error };
  const review = head.data;
  if (!review) return { kind: "not_found" };

  // Read 2 — the trail + the account's other signals. Also fails the whole
  // detail rather than silently rendering an empty trail: an append-only trail
  // that quietly shows nothing is worse than an honest error.
  const body = await safeQueryOrNull(
    async () => {
      const [rawNotes, signals, workflows, accountResult] = await Promise.all([
        adminDrizzle.select().from(antifraud_review_notes)
          .where(eq(antifraud_review_notes.review_id, reviewId))
          .orderBy(desc(antifraud_review_notes.created_at)).limit(200),
        adminDrizzle.select().from(antifraud_signals)
          .where(
            and(
              eq(antifraud_signals.target_user_id, review.target_user_id),
              notInArray(
                antifraud_signals.kind,
                [...NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS],
              ),
            ),
          )
          .orderBy(desc(antifraud_signals.received_at)).limit(25),
        loadReviewWorkflows([reviewId]),
        safeQueryOrNull(
          async () => {
            const main = await getReadDrizzleDb();
            const [accounts, lockRows, financialResult] = await Promise.all([
              main.select({
                email: user.email,
                country: user.country,
                countryCode: user.country_code,
              }).from(user).where(eq(user.id, review.target_user_id)).limit(1),
              main.select({
                depositsCrypto: user_feature_locks.locked_deposits_crypto,
                depositsFiat: user_feature_locks.locked_deposits_fiat,
                withdrawalsCrypto:
                  user_feature_locks.locked_withdrawals_crypto,
                withdrawalsItems:
                  user_feature_locks.locked_withdrawals_items,
                inventorySales: user_feature_locks.locked_inventory_sales,
                exchanges: user_feature_locks.locked_exchanges,
                openings: user_feature_locks.locked_openings,
                vault: user_feature_locks.locked_vault,
              }).from(user_feature_locks).where(
                eq(user_feature_locks.user_id, review.target_user_id),
              ).limit(1),
              main.execute<{
                fiat_deposits: string | null;
                crypto_deposits: string | null;
                wagered: string | null;
              }>(sql`
                SELECT
                  COALESCE((
                    SELECT SUM(amount::numeric)
                      FROM ledger_transactions
                     WHERE user_id = ${review.target_user_id}
                       AND type::text = 'deposit'
                       AND status::text = 'completed'
                       AND crypto_asset IS NULL
                  ), 0)::text AS fiat_deposits,
                  COALESCE((
                    SELECT SUM(amount::numeric)
                      FROM ledger_transactions
                     WHERE user_id = ${review.target_user_id}
                       AND type::text = 'deposit'
                       AND status::text = 'completed'
                       AND crypto_asset IS NOT NULL
                  ), 0)::text AS crypto_deposits,
                  COALESCE((
                    SELECT total_wagered::numeric
                      FROM balances
                     WHERE user_id = ${review.target_user_id}
                     LIMIT 1
                  ), 0)::text AS wagered
              `),
            ]);
            const financial = financialResult.rows[0];
            const locks = lockRows[0];
            const listLock = (label: string, values: string[] | undefined) =>
              values?.length ? `${label} (${values.join(", ")})` : null;
            const activeLocks = [
              listLock("Crypto deposits", locks?.depositsCrypto),
              listLock("Fiat deposits", locks?.depositsFiat),
              listLock("Crypto withdrawals", locks?.withdrawalsCrypto),
              locks?.withdrawalsItems ? "Item withdrawals" : null,
              locks?.inventorySales ? "Inventory sales" : null,
              locks?.exchanges ? "Exchanges" : null,
              locks?.openings ? "Pack openings" : null,
              locks?.vault ? "Vault" : null,
            ].filter((value): value is string => Boolean(value));
            return {
              account: accounts[0] ?? null,
              activeLocks,
              financialFacts: {
                fiatDepositsUsd: toNumber(financial?.fiat_deposits),
                cryptoDepositsUsd: toNumber(financial?.crypto_deposits),
                wageredUsd: toNumber(financial?.wagered),
              },
            };
          },
          "antifraud.review-detail.account",
          3_000,
        ),
      ]);
      const notes = rawNotes
        .filter(
          (note) =>
            note.kind !== "signal" ||
            isUsefulReviewSignalTrailEntry(note.body),
        )
        .slice(0, 100);

      const identities = await loadAdminIdentities([
        review.assigned_to,
        review.opened_by,
        review.resolved_by,
        ...notes.map((n) => n.admin_user_id),
      ]);

      const detail: ReviewDetail = {
        review: toRow(review),
        activeLocks: accountResult.data?.activeLocks ?? [],
        financialFacts: accountResult.data?.financialFacts ?? null,
        workflow: workflows.get(reviewId) ?? null,
        assignee: review.assigned_to
          ? identities.get(review.assigned_to) ?? null
          : null,
        opener: review.opened_by
          ? identities.get(review.opened_by) ?? null
          : null,
        resolver: review.resolved_by
          ? identities.get(review.resolved_by) ?? null
          : null,
        account: accountResult.data?.account ?? null,
        notes: notes.map((note) => ({
          id: note.id,
          kind: note.kind,
          body: note.body,
          adminUserId: note.admin_user_id,
          author: note.admin_user_id
            ? identities.get(note.admin_user_id) ?? null
            : null,
          createdAt: new Date(note.created_at),
        })),
        relatedSignals: signals.map((s) => ({
          id: s.id,
          kind: s.kind,
          severity: s.severity,
          summary: s.summary,
          riskScore: s.risk_score,
          scoreDelta: signalScoreDelta(s.payload),
          receivedAt: new Date(s.received_at),
        })),
      };
      return detail;
    },
    "antifraud.review-detail.trail",
    REVIEW_DETAIL_TIMEOUT_MS,
  );
  if (body.error || !body.data) {
    return { kind: "failed", error: body.error ?? "Case detail unavailable" };
  }

  return { kind: "ok", detail: body.data };
}

export type ReviewStats = {
  open: number;
  inReview: number;
  resolvedToday: number;
  flaggedTotal: number;
  mineOpen: number;
  postponed: number;
};

export type ReviewQueueStats = {
  priority: number;
  normal: number;
  waitingKyc: number;
  postponed: number;
};

export type AccountReviewTabCounts = {
  reviews: number;
  postponed: number;
};

/** Counts for the two operational tabs; low/medium never enter this view. */
export async function getAccountReviewTabCounts(): Promise<AccountReviewTabCounts> {
  const empty = { reviews: 0, postponed: 0 };
  try {
    const result = await adminDrizzle.execute<{
      reviews: string;
      postponed: string;
    }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE review.status IN ('open', 'in_review', 'escalated')
            AND NOT COALESCE(workflow.postponed_until > now(), false)
        ) AS reviews,
        COUNT(*) FILTER (
          WHERE review.status IN ('open', 'in_review', 'escalated')
            AND workflow.postponed_until > now()
        ) AS postponed
      FROM antifraud_reviews AS review
      LEFT JOIN antifraud_review_workflow AS workflow
        ON workflow.review_id = review.id
      WHERE review.severity IN ('high', 'critical')
    `);
    const row = result.rows[0];
    return {
      reviews: Number(row?.reviews ?? 0),
      postponed: Number(row?.postponed ?? 0),
    };
  } catch (error) {
    console.error("[antifraud] getAccountReviewTabCounts failed:", error);
    return empty;
  }
}

export async function getReviewQueueStats(): Promise<ReviewQueueStats> {
  const empty = { priority: 0, normal: 0, waitingKyc: 0, postponed: 0 };
  try {
    const result = await adminDrizzle.execute<{
      priority: string;
      normal: string;
      waiting_kyc: string;
      postponed: string;
    }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE workflow.queue_state = 'priority'
            AND NOT COALESCE(workflow.postponed_until > now(), false)
        ) AS priority,
        COUNT(*) FILTER (
          WHERE COALESCE(workflow.queue_state, 'normal') = 'normal'
            AND NOT COALESCE(workflow.postponed_until > now(), false)
        ) AS normal,
        COUNT(*) FILTER (
          WHERE workflow.queue_state = 'waiting_kyc'
            AND NOT COALESCE(workflow.postponed_until > now(), false)
        ) AS waiting_kyc,
        COUNT(*) FILTER (
          WHERE workflow.postponed_until > now()
        ) AS postponed
      FROM antifraud_reviews AS review
      LEFT JOIN antifraud_review_workflow AS workflow
        ON workflow.review_id = review.id
      WHERE review.status IN ('open', 'in_review', 'escalated')
    `);
    const row = result.rows[0];
    return {
      priority: Number(row?.priority ?? 0),
      normal: Number(row?.normal ?? 0),
      waitingKyc: Number(row?.waiting_kyc ?? 0),
      postponed: Number(row?.postponed ?? 0),
    };
  } catch (error) {
    console.error("[antifraud] getReviewQueueStats failed:", error);
    return empty;
  }
}

/** The dashboard KPI strip. One grouped count + three narrow counts. */
export async function getReviewStats(
  adminUserId?: string,
  excludedTargetUserIds: readonly string[] = [],
): Promise<ReviewStats> {
  const empty: ReviewStats = {
    open: 0,
    inReview: 0,
    resolvedToday: 0,
    flaggedTotal: 0,
    mineOpen: 0,
    postponed: 0,
  };
  try {
    // "Resolved today" means the ANALYST's today. `setHours(0,0,0,0)` uses the
    // SERVER's zone, which on Vercel is UTC — so for anyone outside UTC the
    // tile was wrong twice a day (cases resolved after local midnight were
    // still counted as yesterday's, or vice versa). The workspace already
    // carries a per-admin zone (profile preference → `admin_tz` cookie → UTC);
    // `getLocalDayBounds` turns it into the exact half-open [start, end)
    // instant pair for that zone, DST included.
    const timeZone = await getAdminDisplayTimeZone();
    const { start: startOfToday, end: endOfToday } = getLocalDayBounds(
      new Date(),
      timeZone,
    );
    const targetScope = excludedTargetUserIds.length
      ? sql`
          NOT (
            ${antifraud_reviews.target_user_id} =
            ANY(${pgArrayParam(excludedTargetUserIds)}::text[])
          )
        `
      : sql`TRUE`;

    const result = await adminDrizzle.execute<{
      open: string; in_review: string; flagged: string; postponed: string;
      resolved_today: string; mine_open: string;
    }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'open'
            AND NOT EXISTS (
              SELECT 1 FROM antifraud_review_workflow workflow
              WHERE workflow.review_id = antifraud_reviews.id
                AND workflow.postponed_until > now()
            )
        ) AS open,
        COUNT(*) FILTER (
          WHERE status IN ('in_review', 'escalated')
            AND NOT EXISTS (
              SELECT 1 FROM antifraud_review_workflow workflow
              WHERE workflow.review_id = antifraud_reviews.id
                AND workflow.postponed_until > now()
            )
        ) AS in_review,
        COUNT(*) FILTER (
          WHERE status IN ('open', 'in_review', 'escalated')
            AND EXISTS (
              SELECT 1 FROM antifraud_review_workflow workflow
              WHERE workflow.review_id = antifraud_reviews.id
                AND workflow.postponed_until > now()
            )
        ) AS postponed,
        COUNT(*) FILTER (WHERE status = 'flagged') AS flagged,
        COUNT(*) FILTER (WHERE resolved_at >= ${startOfToday} AND resolved_at < ${endOfToday}) AS resolved_today,
        COUNT(*) FILTER (WHERE assigned_to = ${adminUserId ?? null}::uuid AND status = ANY(${pgArrayParam([...REVIEW_QUEUE_STORAGE_STATUSES])}::text[])) AS mine_open
      FROM antifraud_reviews
      WHERE ${targetScope}
    `);
    const row = result.rows[0];
    const value = (key: keyof NonNullable<typeof row>) => Number(row?.[key] ?? 0);

    return {
      open: value("open"), inReview: value("in_review"),
      resolvedToday: value("resolved_today"),
      flaggedTotal: value("flagged"),
      mineOpen: value("mine_open"),
      postponed: value("postponed"),
    };
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] getReviewStats failed:", err);
    }
    return empty;
  }
}

export type SignalRow = {
  id: string;
  externalId: string | null;
  kind: string;
  severity: string;
  riskScore: number | null;
  targetUserId: string | null;
  targetUsername: string | null;
  summary: string;
  reviewId: string | null;
  receivedAt: Date;
};

/** The dashboard's recent-signal feed (the persisted twin of the live stream). */
export async function listRecentSignals(limit = 25): Promise<SignalRow[]> {
  try {
    const rows = await adminDrizzle.select().from(antifraud_signals)
      .where(
        notInArray(
          antifraud_signals.kind,
          [...NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS],
        ),
      )
      .orderBy(desc(antifraud_signals.received_at))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => ({
      id: row.id,
      externalId: row.external_id,
      kind: row.kind,
      severity: row.severity,
      riskScore: row.risk_score,
      targetUserId: row.target_user_id,
      targetUsername: row.target_username,
      summary: row.summary,
      reviewId: row.review_id,
      receivedAt: new Date(row.received_at),
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listRecentSignals failed:", err);
    }
    return [];
  }
}
