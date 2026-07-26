import "server-only";

import { adminDb } from "@/lib/admin-db";
import { levelForPoints, levelInfo, type StaffLevel } from "./levels";
import { isMissingRelationError, notifyStaff } from "./notifications";
import { loadAdminIdentities, type AdminIdentity } from "./identities";

/**
 * The staff account layer — profiles, the points ledger, and the derived level.
 *
 * A staff profile is created LAZILY: the first time someone opens the Antifraud
 * workspace, `ensureStaffProfile` writes their row. That keeps the members
 * board honest (it lists people who actually use the workspace, not every
 * admin_user that ever existed) and means no backfill was needed to ship this.
 *
 * POINTS DISCIPLINE — `staff_point_events` is the immutable source of truth,
 * exactly like the game ledger: nothing updates or deletes an event, and a
 * mistake is corrected by writing a compensating negative one.
 * `staff_profiles.points_total` / `.level` are denormalized roll-ups written in
 * the SAME transaction as the event, so they cannot drift from the ledger.
 */

export type StaffProfile = {
  adminUserId: string;
  displayName: string | null;
  title: string | null;
  bio: string | null;
  accent: string;
  pointsTotal: number;
  level: number;
  levelInfo: StaffLevel;
  quizzesCompleted: number;
  reviewsResolved: number;
  lastSeenAt: Date | null;
  createdAt: Date;
};

function toProfile(row: {
  admin_user_id: string;
  display_name: string | null;
  title: string | null;
  bio: string | null;
  accent: string;
  points_total: number;
  level: number;
  quizzes_completed: number;
  reviews_resolved: number;
  last_seen_at: Date | null;
  created_at: Date;
}): StaffProfile {
  return {
    adminUserId: row.admin_user_id,
    displayName: row.display_name,
    title: row.title,
    bio: row.bio,
    accent: row.accent,
    pointsTotal: row.points_total,
    level: row.level,
    levelInfo: levelInfo(row.level),
    quizzesCompleted: row.quizzes_completed,
    reviewsResolved: row.reviews_resolved,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

/**
 * Read the caller's staff profile, creating it on first sight and stamping
 * `last_seen_at`. Called once per workspace layout render.
 *
 * Returns `null` only when the tables aren't provisioned on this deployment —
 * the workspace then renders in a degraded but working state rather than
 * white-screening.
 */
export async function ensureStaffProfile(
  adminUserId: string,
): Promise<StaffProfile | null> {
  try {
    const row = await adminDb.staff_profiles.upsert({
      where: { admin_user_id: adminUserId },
      // Only the heartbeat on an existing row — never touch the profile fields
      // the staff member owns.
      update: { last_seen_at: new Date() },
      create: { admin_user_id: adminUserId, last_seen_at: new Date() },
    });
    return toProfile(row);
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] ensureStaffProfile failed:", err);
    }
    return null;
  }
}

/** Read one profile without creating it. */
export async function getStaffProfile(
  adminUserId: string,
): Promise<StaffProfile | null> {
  try {
    const row = await adminDb.staff_profiles.findUnique({
      where: { admin_user_id: adminUserId },
    });
    return row ? toProfile(row) : null;
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] getStaffProfile failed:", err);
    }
    return null;
  }
}

export type StaffMember = {
  profile: StaffProfile;
  identity: AdminIdentity | null;
  rank: number;
};

/**
 * The members board — every staff profile, ranked by points, with the
 * admin_users identity joined in one batched read.
 */
export async function listStaffMembers(): Promise<StaffMember[]> {
  try {
    const rows = await adminDb.staff_profiles.findMany({
      orderBy: [{ points_total: "desc" }, { created_at: "asc" }],
      take: 200,
    });
    const identities = await loadAdminIdentities(
      rows.map((r) => r.admin_user_id),
    );
    return rows.map((row, index) => ({
      profile: toProfile(row),
      identity: identities.get(row.admin_user_id) ?? null,
      rank: index + 1,
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listStaffMembers failed:", err);
    }
    return [];
  }
}

// ─── Points ───────────────────────────────────────────────────────────────

export type AwardPointsInput = {
  adminUserId: string;
  /** Signed. Negative = correction / penalty. */
  points: number;
  /** 'quiz' | 'review' | 'manual' | 'bonus' */
  sourceKind: "quiz" | "review" | "manual" | "bonus";
  /** The originating row id (quiz attempt, review …). NULL for a free award. */
  sourceId?: string | null;
  reason: string;
  /** Acting admin, or null for automatic system awards. */
  createdBy?: string | null;
  /** Extra counters to bump in the same transaction. */
  bump?: { quizzesCompleted?: number; reviewsResolved?: number };
  /** Skip the "points awarded" notification (quiz flow sends its own). */
  silent?: boolean;
};

export type AwardPointsResult = {
  ok: boolean;
  /** True when the unique index rejected a duplicate automatic award. */
  duplicate: boolean;
  pointsTotal: number;
  previousLevel: number;
  level: number;
  leveledUp: boolean;
};

/**
 * Write one points event and roll the profile forward, atomically.
 *
 * IDEMPOTENT for automatic awards: the partial unique index on
 * (source_kind, source_id) means a retried quiz submit can never pay twice —
 * the second write raises P2002 and this returns `duplicate: true` with the
 * profile untouched.
 */
export async function awardStaffPoints(
  input: AwardPointsInput,
): Promise<AwardPointsResult> {
  const failed: AwardPointsResult = {
    ok: false,
    duplicate: false,
    pointsTotal: 0,
    previousLevel: 1,
    level: 1,
    leveledUp: false,
  };

  try {
    const result = await adminDb.$transaction(async (tx) => {
      // Make sure the profile exists — a manual award can land on someone who
      // has never opened the workspace.
      const before = await tx.staff_profiles.upsert({
        where: { admin_user_id: input.adminUserId },
        update: {},
        create: { admin_user_id: input.adminUserId },
      });

      await tx.staff_point_events.create({
        data: {
          admin_user_id: input.adminUserId,
          points: input.points,
          source_kind: input.sourceKind,
          source_id: input.sourceId ?? null,
          reason: input.reason,
          created_by: input.createdBy ?? null,
        },
      });

      const pointsTotal = before.points_total + input.points;
      const level = levelForPoints(pointsTotal).level;

      await tx.staff_profiles.update({
        where: { admin_user_id: input.adminUserId },
        data: {
          points_total: pointsTotal,
          level,
          quizzes_completed:
            input.bump?.quizzesCompleted != null
              ? { increment: input.bump.quizzesCompleted }
              : undefined,
          reviews_resolved:
            input.bump?.reviewsResolved != null
              ? { increment: input.bump.reviewsResolved }
              : undefined,
        },
      });

      return {
        ok: true,
        duplicate: false,
        pointsTotal,
        previousLevel: before.level,
        level,
        leveledUp: level > before.level,
      } satisfies AwardPointsResult;
    });

    // Notifications live OUTSIDE the transaction — an external ping must never
    // hold a DB transaction open, and a failed ping must never roll back points.
    if (result.leveledUp) {
      const info = levelInfo(result.level);
      await notifyStaff({
        recipients: [input.adminUserId],
        kind: "level_up",
        title: `Level ${result.level} — ${info.title}`,
        body: `You reached ${result.pointsTotal} points.`,
        href: "/antifraud/profile",
        metadata: { level: result.level, points: result.pointsTotal },
      });
    }
    if (!input.silent && input.points !== 0) {
      await notifyStaff({
        recipients: [input.adminUserId],
        kind: "points_awarded",
        title:
          input.points > 0
            ? `+${input.points} point${input.points === 1 ? "" : "s"}`
            : `${input.points} points`,
        body: input.reason,
        href: "/antifraud/profile",
        metadata: { points: input.points, source: input.sourceKind },
      });
    }

    return result;
  } catch (err) {
    // P2002 = the idempotency index rejected a duplicate automatic award.
    if ((err as { code?: string })?.code === "P2002") {
      const profile = await getStaffProfile(input.adminUserId);
      return {
        ok: true,
        duplicate: true,
        pointsTotal: profile?.pointsTotal ?? 0,
        previousLevel: profile?.level ?? 1,
        level: profile?.level ?? 1,
        leveledUp: false,
      };
    }
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] awardStaffPoints failed:", err);
    }
    return failed;
  }
}

export type StaffPointEvent = {
  id: string;
  points: number;
  sourceKind: string;
  reason: string;
  createdBy: string | null;
  createdAt: Date;
};

export type StaffPointLedgerEvent = StaffPointEvent & {
  adminUserId: string;
  sourceId: string | null;
  recipient: AdminIdentity | null;
  actor: AdminIdentity | null;
};

/**
 * Manager ledger: newest point movements across the whole team. The bounded
 * order uses staff_point_events_created_idx, then identities are resolved in
 * one primary-key batch.
 */
export async function listRecentStaffPointEvents(
  limit = 100,
): Promise<StaffPointLedgerEvent[]> {
  try {
    const rows = await adminDb.staff_point_events.findMany({
      select: {
        id: true,
        admin_user_id: true,
        points: true,
        source_kind: true,
        source_id: true,
        reason: true,
        created_by: true,
        created_at: true,
      },
      orderBy: { created_at: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const identities = await loadAdminIdentities(
      rows.flatMap((row) => [row.admin_user_id, row.created_by]),
    );
    return rows.map((row) => ({
      id: row.id,
      adminUserId: row.admin_user_id,
      points: row.points,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
      recipient: identities.get(row.admin_user_id) ?? null,
      actor: row.created_by
        ? identities.get(row.created_by) ?? null
        : null,
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listRecentStaffPointEvents failed:", err);
    }
    return [];
  }
}

/** The profile page's activity list. */
export async function listStaffPointEvents(
  adminUserId: string,
  limit = 25,
): Promise<StaffPointEvent[]> {
  try {
    const rows = await adminDb.staff_point_events.findMany({
      where: { admin_user_id: adminUserId },
      orderBy: { created_at: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((row) => ({
      id: row.id,
      points: row.points,
      sourceKind: row.source_kind,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listStaffPointEvents failed:", err);
    }
    return [];
  }
}
