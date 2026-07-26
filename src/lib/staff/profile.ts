import "server-only";

import { asc, desc, eq, sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { staff_point_events, staff_profiles } from "@/lib/db-schema/admin/schema";
import { levelForPoints, levelInfo, type StaffLevel } from "./levels";
import { isMissingRelationError, notifyStaff } from "./notifications";
import { loadAdminIdentities, type AdminIdentity } from "./identities";

/**
 * The staff account layer — profiles, the points ledger, and the derived level.
 *
 * A staff profile is created lazily by a post-render presence action the first
 * time someone opens the Staff hub. That keeps the members board honest (it
 * lists people who actually use the workspace, not every admin_user that ever
 * existed) without mutating the ADMIN database during a Server Component
 * render.
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
 * Create the caller's staff profile on first sight and stamp `last_seen_at`.
 * This is a write helper for the authenticated presence Server Action; page
 * and layout Server Components must use `getStaffProfile` instead.
 *
 * Returns `null` only when the tables aren't provisioned on this deployment —
 * the workspace then renders in a degraded but working state rather than
 * white-screening.
 */
export async function recordStaffPresence(
  adminUserId: string,
): Promise<StaffProfile | null> {
  try {
    const [row] = await adminDrizzle.insert(staff_profiles).values({
      admin_user_id: adminUserId,
      // Only the heartbeat on an existing row — never touch the profile fields
      // the staff member owns.
      last_seen_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: staff_profiles.admin_user_id,
      set: { last_seen_at: new Date().toISOString() },
    }).returning();
    return row ? toProfile({ ...row, last_seen_at: row.last_seen_at ? new Date(row.last_seen_at) : null, created_at: new Date(row.created_at) }) : null;
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[staff] recordStaffPresence failed:", err);
    }
    return null;
  }
}

/** Read one profile without creating it. */
export async function getStaffProfile(
  adminUserId: string,
): Promise<StaffProfile | null> {
  try {
    const [row] = await adminDrizzle.select().from(staff_profiles)
      .where(eq(staff_profiles.admin_user_id, adminUserId)).limit(1);
    return row ? toProfile({ ...row, last_seen_at: row.last_seen_at ? new Date(row.last_seen_at) : null, created_at: new Date(row.created_at) }) : null;
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
    const rows = await adminDrizzle.select().from(staff_profiles)
      .orderBy(desc(staff_profiles.points_total), asc(staff_profiles.created_at)).limit(200);
    const identities = await loadAdminIdentities(
      rows.map((r) => r.admin_user_id),
    );
    const supportRows = rows.filter((row) =>
      identities.get(row.admin_user_id)?.roles.includes("support"),
    );
    return supportRows.map((row, index) => ({
      profile: toProfile({ ...row, last_seen_at: row.last_seen_at ? new Date(row.last_seen_at) : null, created_at: new Date(row.created_at) }),
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

type AdminTransaction = Parameters<
  Parameters<typeof adminDrizzle.transaction>[0]
>[0];

const failedAward: AwardPointsResult = {
  ok: false,
  duplicate: false,
  pointsTotal: 0,
  previousLevel: 1,
  level: 1,
  leveledUp: false,
};

export async function awardStaffPointsInTransaction(
  tx: AdminTransaction,
  input: AwardPointsInput,
): Promise<AwardPointsResult> {
  await tx.insert(staff_profiles).values({ admin_user_id: input.adminUserId })
    .onConflictDoNothing({ target: staff_profiles.admin_user_id });
  const [before] = await tx.select().from(staff_profiles)
    .where(eq(staff_profiles.admin_user_id, input.adminUserId))
    .for("update").limit(1);
  if (!before) throw new Error("Staff profile upsert returned no row");

  const inserted = await tx.insert(staff_point_events).values({
    admin_user_id: input.adminUserId,
    points: input.points,
    source_kind: input.sourceKind,
    source_id: input.sourceId ?? null,
    reason: input.reason,
    created_by: input.createdBy ?? null,
  }).onConflictDoNothing({
    target: [staff_point_events.source_kind, staff_point_events.source_id],
    // This must stay literal so PostgreSQL can infer the matching partial
    // unique index while planning a prepared statement.
    where: sql`${staff_point_events.source_id} IS NOT NULL
      AND ${staff_point_events.source_kind} <> 'manual'`,
  }).returning({ id: staff_point_events.id });
  if (inserted.length === 0) {
    return {
      ok: true,
      duplicate: true,
      pointsTotal: before.points_total,
      previousLevel: before.level,
      level: before.level,
      leveledUp: false,
    };
  }

  const pointsTotal = before.points_total + input.points;
  const level = levelForPoints(pointsTotal).level;
  await tx.update(staff_profiles).set({
    points_total: pointsTotal,
    level,
    quizzes_completed:
      input.bump?.quizzesCompleted != null
        ? sql`${staff_profiles.quizzes_completed} + ${input.bump.quizzesCompleted}`
        : undefined,
    reviews_resolved:
      input.bump?.reviewsResolved != null
        ? sql`${staff_profiles.reviews_resolved} + ${input.bump.reviewsResolved}`
        : undefined,
  }).where(eq(staff_profiles.admin_user_id, input.adminUserId));

  return {
    ok: true,
    duplicate: false,
    pointsTotal,
    previousLevel: before.level,
    level,
    leveledUp: level > before.level,
  };
}

export async function sendStaffPointNotifications(
  input: AwardPointsInput,
  result: AwardPointsResult,
): Promise<void> {
  if (!result.ok || result.duplicate) return;
  if (result.leveledUp) {
    const info = levelInfo(result.level);
    await notifyStaff({
      recipients: [input.adminUserId],
      kind: "level_up",
      title: `Level ${result.level} — ${info.title}`,
      body: `You reached ${result.pointsTotal} points.`,
      href: "/staff/profile",
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
      href: "/staff/profile",
      metadata: { points: input.points, source: input.sourceKind },
    });
  }
}

/**
 * Write one points event and roll the profile forward, atomically.
 *
 * IDEMPOTENT for automatic awards: the partial unique index on
 * (source_kind, source_id) means a retried quiz submit can never pay twice —
 * the second insert becomes a no-op and this returns `duplicate: true` with
 * the profile untouched.
 */
export async function awardStaffPoints(
  input: AwardPointsInput,
): Promise<AwardPointsResult> {
  try {
    const result = await adminDrizzle.transaction((tx) =>
      awardStaffPointsInTransaction(tx, input),
    );

    // Notifications live OUTSIDE the transaction — an external ping must never
    // hold a DB transaction open, and a failed ping must never roll back points.
    await sendStaffPointNotifications(input, result);
    return result;
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] awardStaffPoints failed:", err);
    }
    return failedAward;
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
 * Manager ledger: newest point movements for support users. The bounded
 * order uses staff_point_events_created_idx, then identities are resolved in
 * one primary-key batch.
 */
export async function listRecentStaffPointEvents(
  limit = 100,
): Promise<StaffPointLedgerEvent[]> {
  try {
    const rows = await adminDrizzle
      .select({
        id: staff_point_events.id,
        admin_user_id: staff_point_events.admin_user_id,
        points: staff_point_events.points,
        source_kind: staff_point_events.source_kind,
        source_id: staff_point_events.source_id,
        reason: staff_point_events.reason,
        created_by: staff_point_events.created_by,
        created_at: staff_point_events.created_at,
      })
      .from(staff_point_events)
      .orderBy(desc(staff_point_events.created_at))
      .limit(Math.min(Math.max(limit, 1), 200));
    const identities = await loadAdminIdentities(
      rows.flatMap((row) => [row.admin_user_id, row.created_by]),
    );
    return rows
      .filter((row) =>
        identities.get(row.admin_user_id)?.roles.includes("support"),
      )
      .map((row) => ({
        id: row.id,
        adminUserId: row.admin_user_id,
        points: row.points,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        reason: row.reason,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at),
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
    const rows = await adminDrizzle.select().from(staff_point_events)
      .where(eq(staff_point_events.admin_user_id, adminUserId))
      .orderBy(desc(staff_point_events.created_at))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => ({
      id: row.id,
      points: row.points,
      sourceKind: row.source_kind,
      reason: row.reason,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
    }));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listStaffPointEvents failed:", err);
    }
    return [];
  }
}
