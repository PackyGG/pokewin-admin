import "server-only";

import { adminDb } from "@/lib/admin-db";
import { isMissingRelationError } from "../staff/notifications";
import { loadAdminIdentities, type AdminIdentity } from "../staff/identities";
import {
  OPEN_REVIEW_STATUSES,
  type ReviewSeverity,
  type ReviewStatus,
} from "./constants";

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

// The status/severity vocabulary itself lives in the isomorphic
// `./constants` module so Client Components (the queue dialogs, the case
// controls) can import it WITHOUT dragging this server-only file — and
// therefore Prisma — into the browser bundle. Re-exported here so every
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
};

export type ReviewNote = {
  id: string;
  kind: string;
  body: string;
  adminUserId: string | null;
  author: AdminIdentity | null;
  createdAt: Date;
};

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
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): ReviewRow {
  return {
    id: row.id,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username,
    status: row.status,
    severity: row.severity,
    source: row.source,
    riskScore: row.risk_score,
    reason: row.reason,
    signals: [...row.signals],
    assignedTo: row.assigned_to,
    openedBy: row.opened_by,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────

export type ReviewFilters = {
  /** Omit for the default "still needs work" set. "all" for everything. */
  status?: ReviewStatus | "all" | "unresolved";
  severity?: ReviewSeverity;
  /** Limit to cases assigned to this admin. */
  assignedTo?: string;
  /** Substring match on the denormalized username / user id. */
  search?: string;
  limit?: number;
};

/**
 * The queue. Every filter combination is served by one of the four indexes on
 * the table: (status, created_at DESC) for the status filter, (assigned_to,
 * created_at DESC) for "my queue", (target_user_id) for the player lookup, and
 * (created_at DESC) for the bare list.
 */
export async function listReviews(
  filters: ReviewFilters = {},
): Promise<ReviewListItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 300);
  try {
    const where: Record<string, unknown> = {};

    if (filters.status === "all") {
      // no status predicate
    } else if (filters.status && filters.status !== "unresolved") {
      where.status = filters.status;
    } else {
      where.status = { in: [...OPEN_REVIEW_STATUSES] };
    }

    if (filters.severity) where.severity = filters.severity;
    if (filters.assignedTo) where.assigned_to = filters.assignedTo;
    if (filters.search) {
      const term = filters.search.trim();
      if (term) {
        where.OR = [
          { target_username: { contains: term, mode: "insensitive" } },
          { target_user_id: { contains: term } },
          { reason: { contains: term, mode: "insensitive" } },
        ];
      }
    }

    const rows = await adminDb.antifraud_reviews.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
    });

    const identities = await loadAdminIdentities(
      rows.flatMap((r) => [r.assigned_to, r.opened_by]),
    );

    return rows.map((row) => ({
      ...toRow(row),
      assignee: row.assigned_to ? identities.get(row.assigned_to) ?? null : null,
      opener: row.opened_by ? identities.get(row.opened_by) ?? null : null,
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listReviews failed:", err);
    }
    return [];
  }
}

export type ReviewDetail = {
  review: ReviewRow;
  assignee: AdminIdentity | null;
  opener: AdminIdentity | null;
  resolver: AdminIdentity | null;
  notes: ReviewNote[];
  /** Other signals that arrived for the same account. */
  relatedSignals: {
    id: string;
    kind: string;
    severity: string;
    summary: string;
    riskScore: number | null;
    receivedAt: Date;
  }[];
};

export async function getReviewDetail(
  reviewId: string,
): Promise<ReviewDetail | null> {
  try {
    const review = await adminDb.antifraud_reviews.findUnique({
      where: { id: reviewId },
    });
    if (!review) return null;

    const [notes, signals] = await Promise.all([
      adminDb.antifraud_review_notes.findMany({
        where: { review_id: reviewId },
        orderBy: { created_at: "desc" },
        take: 100,
      }),
      adminDb.antifraud_signals.findMany({
        where: { target_user_id: review.target_user_id },
        orderBy: { received_at: "desc" },
        take: 25,
      }),
    ]);

    const identities = await loadAdminIdentities([
      review.assigned_to,
      review.opened_by,
      review.resolved_by,
      ...notes.map((n) => n.admin_user_id),
    ]);

    return {
      review: toRow(review),
      assignee: review.assigned_to
        ? identities.get(review.assigned_to) ?? null
        : null,
      opener: review.opened_by ? identities.get(review.opened_by) ?? null : null,
      resolver: review.resolved_by
        ? identities.get(review.resolved_by) ?? null
        : null,
      notes: notes.map((note) => ({
        id: note.id,
        kind: note.kind,
        body: note.body,
        adminUserId: note.admin_user_id,
        author: note.admin_user_id
          ? identities.get(note.admin_user_id) ?? null
          : null,
        createdAt: note.created_at,
      })),
      relatedSignals: signals.map((s) => ({
        id: s.id,
        kind: s.kind,
        severity: s.severity,
        summary: s.summary,
        riskScore: s.risk_score,
        receivedAt: s.received_at,
      })),
    };
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] getReviewDetail failed:", err);
    }
    return null;
  }
}

export type ReviewStats = {
  open: number;
  inReview: number;
  escalated: number;
  resolvedToday: number;
  flaggedTotal: number;
  criticalOpen: number;
  mineOpen: number;
};

/** The dashboard KPI strip. One grouped count + three narrow counts. */
export async function getReviewStats(
  adminUserId?: string,
): Promise<ReviewStats> {
  const empty: ReviewStats = {
    open: 0,
    inReview: 0,
    escalated: 0,
    resolvedToday: 0,
    flaggedTotal: 0,
    criticalOpen: 0,
    mineOpen: 0,
  };
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [byStatus, resolvedToday, criticalOpen, mineOpen] = await Promise.all([
      adminDb.antifraud_reviews.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      adminDb.antifraud_reviews.count({
        where: { resolved_at: { gte: startOfToday } },
      }),
      adminDb.antifraud_reviews.count({
        where: {
          severity: "critical",
          status: { in: [...OPEN_REVIEW_STATUSES] },
        },
      }),
      adminUserId
        ? adminDb.antifraud_reviews.count({
            where: {
              assigned_to: adminUserId,
              status: { in: [...OPEN_REVIEW_STATUSES] },
            },
          })
        : Promise.resolve(0),
    ]);

    const count = (status: string) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      open: count("open"),
      inReview: count("in_review"),
      escalated: count("escalated"),
      resolvedToday,
      flaggedTotal: count("flagged"),
      criticalOpen,
      mineOpen,
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
    const rows = await adminDb.antifraud_signals.findMany({
      orderBy: { received_at: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
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
      receivedAt: row.received_at,
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listRecentSignals failed:", err);
    }
    return [];
  }
}
