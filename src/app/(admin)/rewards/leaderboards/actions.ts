"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { getPrimaryDrizzleDb } from "@/lib/db";
import {
  race_claim_holds,
  race_claims,
  race_periods,
  race_prize_tiers,
} from "@/lib/db-schema/main/schema";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

const RACE_TYPES = ["daily", "weekly", "monthly"] as const;
type RaceType = (typeof RACE_TYPES)[number];
const VALID_RACE_TYPES = new Set<string>(RACE_TYPES);

/**
 * Create or update a race prize tier. The unique key on the table is
 * (race_type, position), so we upsert on that pair — both "edit the
 * prize for daily #1" and "add a new weekly #4" go through this one
 * action. Called from the inline edit and the "Add Tier" form on
 * /rewards/leaderboards → Prize Tiers tab.
 */
export async function upsertRacePrizeTier(
  raceType: string,
  position: number,
  prizeAmountUsd: number,
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  if (!VALID_RACE_TYPES.has(raceType)) {
    throw new Error("Invalid race type (must be daily, weekly, or monthly)");
  }
  if (!Number.isInteger(position) || position < 1) {
    throw new Error("Position must be a positive integer");
  }
  if (!Number.isFinite(prizeAmountUsd) || prizeAmountUsd < 0) {
    throw new Error("Prize amount must be a non-negative number");
  }

  await requireCapability(
    session,
    "__can_upsert_race_prize_tier",
    "upsert race prize tiers",
  );

  const validRaceType = raceType as RaceType;
  const [existing] = await db
    .select({
      id: race_prize_tiers.id,
      prize_amount_usd: race_prize_tiers.prize_amount_usd,
    })
    .from(race_prize_tiers)
    .where(
      and(
        eq(race_prize_tiers.race_type, validRaceType),
        eq(race_prize_tiers.position, position),
      ),
    )
    .limit(1);

  await db
    .insert(race_prize_tiers)
    .values({
      race_type: validRaceType,
      position,
      prize_amount_usd: String(prizeAmountUsd),
    })
    .onConflictDoUpdate({
      target: [race_prize_tiers.position, race_prize_tiers.race_type],
      set: {
        prize_amount_usd: String(prizeAmountUsd),
        updated_at: new Date().toISOString(),
      },
    });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: existing
      ? "race_prize_tier_updated"
      : "race_prize_tier_created",
    metadata: {
      race_type: raceType,
      position,
      prize_amount_usd: prizeAmountUsd,
      ...(existing
        ? { old_prize_amount_usd: Number(existing.prize_amount_usd) }
        : {}),
    },
  });

  revalidatePath("/rewards");
}

/**
 * Bulk-upsert race prize tiers. Used by the "Add Multiple" flow on
 * the Prize Tiers tab so an admin can stage a whole podium worth of
 * positions and persist them in a single click instead of saving
 * after every row.
 *
 * Atomicity: all-or-nothing via a database transaction — a bad row in the
 * middle (duplicate position, negative amount, etc.) rolls back any
 * partial work, so the table on screen never gets stuck with half a
 * podium applied. Validation runs UP FRONT before we touch the DB so
 * a typo doesn't even open a transaction.
 */
export async function upsertRacePrizeTiersBulk(
  raceType: string,
  rows: { position: number; prizeAmountUsd: number }[],
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  if (!VALID_RACE_TYPES.has(raceType)) {
    throw new Error("Invalid race type (must be daily, weekly, or monthly)");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("At least one row is required");
  }
  // Cap the batch so a typo in the form (or a malicious payload) can't
  // chew through the table. 100 positions is well above any real podium.
  if (rows.length > 100) {
    throw new Error("Too many rows in one batch (max 100)");
  }

  const seenPositions = new Set<number>();
  for (const row of rows) {
    if (!Number.isInteger(row.position) || row.position < 1) {
      throw new Error(`Invalid position "${row.position}" — must be a positive integer`);
    }
    if (
      !Number.isFinite(row.prizeAmountUsd) ||
      row.prizeAmountUsd < 0
    ) {
      throw new Error(
        `Invalid prize amount for #${row.position} — must be a non-negative number`,
      );
    }
    if (seenPositions.has(row.position)) {
      throw new Error(
        `Duplicate position #${row.position} in the same batch`,
      );
    }
    seenPositions.add(row.position);
  }

  await requireCapability(
    session,
    "__can_upsert_race_prize_tier",
    "upsert race prize tiers",
  );

  // Resolve which rows are inserts vs updates BEFORE the transaction
  // so the audit metadata can label each one accurately. One round-trip
  // for the page's worth of positions.
  const validRaceType = raceType as RaceType;
  const existing = await db
    .select({
      id: race_prize_tiers.id,
      position: race_prize_tiers.position,
      prize_amount_usd: race_prize_tiers.prize_amount_usd,
    })
    .from(race_prize_tiers)
    .where(
      and(
        eq(race_prize_tiers.race_type, validRaceType),
        inArray(
          race_prize_tiers.position,
          rows.map((r) => r.position),
        ),
      ),
    );
  const existingByPosition = new Map(existing.map((e) => [e.position, e]));

  await db
    .insert(race_prize_tiers)
    .values(
      rows.map((row) => ({
        race_type: validRaceType,
        position: row.position,
        prize_amount_usd: String(row.prizeAmountUsd),
      })),
    )
    .onConflictDoUpdate({
      target: [race_prize_tiers.position, race_prize_tiers.race_type],
      set: {
        prize_amount_usd: sql`excluded.prize_amount_usd`,
        updated_at: new Date().toISOString(),
      },
    });

  // One audit event for the whole batch (rather than N events) so the
  // audit log doesn't get spammed by a single "set up the podium" admin
  // action. Per-row detail is preserved in the metadata array.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_prize_tiers_bulk_upserted",
    metadata: {
      race_type: raceType,
      count: rows.length,
      rows: rows.map((r) => {
        const prior = existingByPosition.get(r.position);
        return {
          position: r.position,
          prize_amount_usd: r.prizeAmountUsd,
          op: prior ? "updated" : "created",
          ...(prior
            ? { old_prize_amount_usd: Number(prior.prize_amount_usd) }
            : {}),
        };
      }),
    },
  });

  revalidatePath("/rewards");
  return { upserted: rows.length };
}

/**
 * Remove a race prize tier. Used when an admin wants to stop awarding
 * a specific position — e.g. dropping weekly #10 after shrinking the
 * podium. Deletion is hard; no soft-delete column on the table.
 */
export async function deleteRacePrizeTier(id: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  const [existing] = await db
    .select({
      race_type: race_prize_tiers.race_type,
      position: race_prize_tiers.position,
      prize_amount_usd: race_prize_tiers.prize_amount_usd,
    })
    .from(race_prize_tiers)
    .where(eq(race_prize_tiers.id, id))
    .limit(1);
  if (!existing) {
    throw new Error("Prize tier not found");
  }

  await requireCapability(
    session,
    "__can_delete_race_prize_tier",
    "delete race prize tiers",
  );

  await db.delete(race_prize_tiers).where(eq(race_prize_tiers.id, id));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_prize_tier_deleted",
    metadata: {
      tier_id: id,
      race_type: existing.race_type,
      position: existing.position,
      prize_amount_usd: Number(existing.prize_amount_usd),
    },
  });

  revalidatePath("/rewards");
}

// ──────────────────────────────────────────────────────────────────────────
// Race period management
//
// race_periods is the source of truth for which race is currently running
// for each type. Daily/weekly auto-rolling rows are bootstrapped by the
// backend migration; monthly has no row until an admin starts one here.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Start a new race period. Used primarily for monthly (which has no
 * automatic bootstrapping) but also lets an admin manually restart a
 * daily/weekly race after auto_renew=false caused it to stop.
 *
 * Enforces "one active period per race_type" via the partial unique index
 * on the table; the previous active period (if any) must be ended first.
 *
 * Daily/weekly periods are always snapped to UTC midnight server-side —
 * the admin doesn't pick times. Drifted off-day boundaries caused
 * production claim failures (May 2026 incident: late rollover stamped
 * starts_at=02:37, getEndedByStart's exact-timestamp eq() stopped matching
 * the snapshot's date-typed period_start, and 10 winners couldn't claim).
 * Monthly still accepts explicit dates because admins schedule custom
 * 10th-to-10th cadences.
 */
export async function startRacePeriod(params: {
  raceType: string;
  autoRenew: boolean;
  // Monthly only: 'YYYY-MM-DD' (interpreted as UTC midnight). Ignored for
  // daily/weekly, which always snap to today's UTC midnight + standard span.
  monthlyStartDate?: string;
  monthlyEndDate?: string;
}) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  const { raceType, autoRenew, monthlyStartDate, monthlyEndDate } = params;

  if (!VALID_RACE_TYPES.has(raceType)) {
    throw new Error("Invalid race type (must be daily, weekly, or monthly)");
  }

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const DAY_MS = 24 * 60 * 60 * 1000;
  const todayUtcMidnight = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };

  let startsAtDate: Date;
  let endsAtDate: Date;

  if (raceType === "daily") {
    startsAtDate = todayUtcMidnight();
    endsAtDate = new Date(startsAtDate.getTime() + DAY_MS);
  } else if (raceType === "weekly") {
    startsAtDate = todayUtcMidnight();
    endsAtDate = new Date(startsAtDate.getTime() + 7 * DAY_MS);
  } else {
    if (!monthlyStartDate || !monthlyEndDate) {
      throw new Error("Monthly race requires start and end dates");
    }
    startsAtDate = new Date(`${monthlyStartDate}T00:00:00.000Z`);
    endsAtDate = new Date(`${monthlyEndDate}T00:00:00.000Z`);
    if (Number.isNaN(startsAtDate.getTime())) {
      throw new Error("Invalid start date");
    }
    if (Number.isNaN(endsAtDate.getTime())) {
      throw new Error("Invalid end date");
    }
    if (endsAtDate <= startsAtDate) {
      throw new Error("End date must be after start date");
    }
  }

  // Reject if an active period already exists for this type. A clearer
  // error than waiting for the partial unique index to fire.
  const validRaceType = raceType as RaceType;
  const [existing] = await db
    .select({ id: race_periods.id, ends_at: race_periods.ends_at })
    .from(race_periods)
    .where(
      and(
        eq(race_periods.race_type, validRaceType),
        eq(race_periods.status, "active"),
      ),
    )
    .limit(1);
  if (existing) {
    throw new Error(
      `An active ${raceType} period already exists (ends ${new Date(existing.ends_at).toISOString()}). End it first.`,
    );
  }

  const [created] = await db
    .insert(race_periods)
    .values({
      race_type: validRaceType,
      starts_at: startsAtDate.toISOString(),
      ends_at: endsAtDate.toISOString(),
      auto_renew: autoRenew,
      status: "active",
    })
    .returning({ id: race_periods.id });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_period_started",
    metadata: {
      period_id: created.id,
      race_type: raceType,
      starts_at: startsAtDate.toISOString(),
      ends_at: endsAtDate.toISOString(),
      auto_renew: autoRenew,
    },
  });

  revalidatePath("/rewards");
}

/**
 * Toggle auto_renew on a period. The backend's lazy rollover honors this
 * when the period ends: true → insert next period, false → leave dormant
 * until an admin starts a new one.
 */
export async function toggleRacePeriodAutoRenew(periodId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const [existing] = await db
    .select({
      id: race_periods.id,
      race_type: race_periods.race_type,
      auto_renew: race_periods.auto_renew,
      status: race_periods.status,
    })
    .from(race_periods)
    .where(eq(race_periods.id, periodId))
    .limit(1);
  if (!existing) {
    throw new Error("Race period not found");
  }

  const next = !existing.auto_renew;
  await db
    .update(race_periods)
    .set({ auto_renew: next, updated_at: new Date().toISOString() })
    .where(eq(race_periods.id, periodId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_period_auto_renew_toggled",
    metadata: {
      period_id: periodId,
      race_type: existing.race_type,
      auto_renew: next,
      old_auto_renew: existing.auto_renew,
    },
  });

  revalidatePath("/rewards");
}

/**
 * Force-end an active period right now. Snapshots are generated inline
 * (same SUM/GROUP BY the backend uses on lazy rollover) so the period's
 * leaderboard freezes and prizes become claimable. We do NOT auto-create
 * the next period here — even when auto_renew is on, an explicit "end now"
 * is treated as an admin pause; the next period starts when admin says so.
 */
export async function endRacePeriodNow(periodId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const [existing] = await db
    .select({
      id: race_periods.id,
      race_type: race_periods.race_type,
      starts_at: race_periods.starts_at,
      ends_at: race_periods.ends_at,
      status: race_periods.status,
    })
    .from(race_periods)
    .where(eq(race_periods.id, periodId))
    .limit(1);
  if (!existing) {
    throw new Error("Race period not found");
  }
  if (existing.status !== "active") {
    throw new Error("Period is not active");
  }

  const periodStartIso = new Date(existing.starts_at).toISOString().slice(0, 10);
  const excluded = await getExcludedUserIds();
  const blacklistFilter =
    excluded.length === 0
      ? sql``
      : sql`AND u.id NOT IN (${sql.join(
          excluded.map((id) => sql`${id}`),
          sql`, `,
        )})`;

  await db.transaction(async (tx) => {
    // Snapshot generation: aggregate game_sessions over the period range,
    // assign positions, exclude bots and ineligible roles. Mirrors the live
    // standings query (getLiveRaceStandings in src/lib/queries/races.ts):
    // race_eligible filter, COALESCE(weighted_bet_amount, bet_amount),
    // HAVING > 0 and ROW_NUMBER with the same user_id tie-break — so the
    // frozen snapshot pays exactly the ranks the live leaderboard showed.
    await tx.execute(sql`
      INSERT INTO race_leaderboard_snapshots
        (user_id, race_type, period_start, period_end, position, wagered_usd)
      SELECT
        w.user_id,
        ${existing.race_type}::race_type,
        ${periodStartIso}::date,
        ${existing.ends_at}::timestamp,
        (ROW_NUMBER() OVER (ORDER BY w.wagered_usd::decimal DESC, w.user_id ASC))::int,
        w.wagered_usd
      FROM (
        SELECT
          gs.user_id,
          SUM(COALESCE(gs.weighted_bet_amount, gs.bet_amount)) AS wagered_usd
        FROM game_sessions gs
        INNER JOIN "user" u ON u.id = gs.user_id
        WHERE gs.race_eligible = true
          AND gs.user_id IS NOT NULL
          AND gs.created_at >= ${existing.starts_at}
          AND gs.created_at < ${existing.ends_at}
          AND (u.role IS NULL OR u.role NOT IN ('admin', 'creator', 'support'))
          ${blacklistFilter}
        GROUP BY gs.user_id
        HAVING SUM(COALESCE(gs.weighted_bet_amount, gs.bet_amount)) > 0
      ) w
      ON CONFLICT (user_id, race_type, period_start) DO NOTHING
    `);

    await tx
      .update(race_periods)
      .set({ status: "ended", updated_at: new Date().toISOString() })
      .where(eq(race_periods.id, periodId));
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_period_ended",
    metadata: {
      period_id: periodId,
      race_type: existing.race_type,
      starts_at: new Date(existing.starts_at).toISOString(),
      ends_at: new Date(existing.ends_at).toISOString(),
    },
  });

  revalidatePath("/rewards");
}

/**
 * Freeze or open claims for an ended race period — the global claim
 * kill-switch (backend migration 0127). While claims_frozen is true NO
 * winner can claim their prize (the backend rejects every claim with
 * RACE_CLAIMS_FROZEN). Monthly periods are frozen automatically on rollover
 * so a fraud review can run; opening (frozen=false) is the single action
 * that releases payouts for every winner at once and records who/when.
 *
 * Only meaningful on ended periods: an active race has no claimable prizes
 * yet, so we reject freezing one to avoid a confusing no-op state.
 */
export async function setRacePeriodClaimsFrozen(
  periodId: string,
  frozen: boolean,
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const [existing] = await db
    .select({
      id: race_periods.id,
      race_type: race_periods.race_type,
      status: race_periods.status,
      claims_frozen: race_periods.claims_frozen,
    })
    .from(race_periods)
    .where(eq(race_periods.id, periodId))
    .limit(1);
  if (!existing) {
    throw new Error("Race period not found");
  }
  if (existing.status !== "ended") {
    throw new Error("Claims can only be frozen or opened on ended periods");
  }
  if (existing.claims_frozen === frozen) {
    throw new Error(
      frozen ? "Claims are already frozen" : "Claims are already open",
    );
  }

  await db
    .update(race_periods)
    .set(
      frozen
      ? // Re-freezing after an open: clear the prior unfreeze audit fields so
        // they only ever reflect the most recent open.
        {
          claims_frozen: true,
          claims_unfrozen_at: null,
          claims_unfrozen_by: null,
          updated_at: new Date().toISOString(),
        }
      : // Opening: stamp who released payouts and when, matching the backend's
        // setClaimsFrozen contract on the period row.
        {
          claims_frozen: false,
          claims_unfrozen_at: new Date().toISOString(),
          claims_unfrozen_by: session.userId,
          updated_at: new Date().toISOString(),
        },
    )
    .where(eq(race_periods.id, periodId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: frozen
      ? "race_period_claims_frozen"
      : "race_period_claims_opened",
    metadata: {
      period_id: periodId,
      race_type: existing.race_type,
    },
  });

  revalidatePath("/rewards");
}

// ──────────────────────────────────────────────────────────────────────────
// Per-user claim holds (fraud review)
//
// A hold freezes a SINGLE user's claim for a SINGLE period while a wager-abuse
// review is open — distinct from the period-wide claims_frozen kill-switch.
// Mirrors the backend's freezeUserClaim/unfreezeUserClaim (race.service.ts):
// at most one active hold per (user, race_type, period), a reason is required,
// and an already-claimed prize cannot be frozen (it needs a clawback instead).
// released_at IS NULL == active hold; releasing keeps the row for the audit
// trail. periodStart is the snapshot's period_start ('YYYY-MM-DD', UTC date).
// ──────────────────────────────────────────────────────────────────────────

function parsePeriodStart(periodStart: string): string {
  const d = new Date(periodStart);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid period start date");
  }
  return d.toISOString().slice(0, 10);
}

export async function freezeUserRaceClaim(params: {
  userId: string;
  raceType: string;
  periodStart: string;
  reason: string;
}) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  const { userId, raceType, periodStart, reason } = params;

  if (!VALID_RACE_TYPES.has(raceType)) {
    throw new Error("Invalid race type (must be daily, weekly, or monthly)");
  }
  if (!reason || reason.trim().length === 0) {
    throw new Error("A reason is required to freeze a claim");
  }
  if (reason.length > 500) {
    throw new Error("Reason must be 500 characters or fewer");
  }

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const periodDate = parsePeriodStart(periodStart);

  // Can't freeze a prize that's already been paid out — that needs a clawback,
  // not a hold. Mirrors the backend's RACE_ALREADY_CLAIMED guard.
  const validRaceType = raceType as RaceType;
  const [existingClaim] = await db
    .select({ id: race_claims.id })
    .from(race_claims)
    .where(
      and(
        eq(race_claims.user_id, userId),
        eq(race_claims.race_type, validRaceType),
        eq(race_claims.race_period_start, periodDate),
      ),
    )
    .limit(1);
  if (existingClaim) {
    throw new Error(
      "Prize already claimed — freezing cannot block a paid prize",
    );
  }

  const [alreadyHeld] = await db
    .select({ id: race_claim_holds.id })
    .from(race_claim_holds)
    .where(
      and(
        eq(race_claim_holds.user_id, userId),
        eq(race_claim_holds.race_type, validRaceType),
        eq(race_claim_holds.race_period_start, periodDate),
        isNull(race_claim_holds.released_at),
      ),
    )
    .limit(1);
  if (alreadyHeld) {
    throw new Error("This claim is already frozen");
  }

  try {
    await db.insert(race_claim_holds).values({
      user_id: userId,
      race_type: validRaceType,
      race_period_start: periodDate,
      reason: reason.trim(),
      created_by: session.userId,
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new Error("This claim is already frozen");
    }
    throw error;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_claim_frozen",
    targetUserId: userId,
    metadata: {
      race_type: raceType,
      race_period_start: periodStart,
      reason: reason.trim(),
    },
  });

  revalidatePath("/rewards");
}

export async function unfreezeUserRaceClaim(params: {
  userId: string;
  raceType: string;
  periodStart: string;
  releaseReason?: string | null;
}) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  const { userId, raceType, periodStart, releaseReason } = params;

  if (!VALID_RACE_TYPES.has(raceType)) {
    throw new Error("Invalid race type (must be daily, weekly, or monthly)");
  }
  if (releaseReason && releaseReason.length > 500) {
    throw new Error("Release reason must be 500 characters or fewer");
  }

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const periodDate = parsePeriodStart(periodStart);

  // Release the active hold only. updateMany keeps this race-safe: if no active
  // hold matches (already released elsewhere), count is 0 and we surface a
  // clean error instead of silently succeeding. Mirrors releaseClaimHold.
  const validRaceType = raceType as RaceType;
  const updated = await db
    .update(race_claim_holds)
    .set({
      released_at: new Date().toISOString(),
      released_by: session.userId,
      release_reason: releaseReason?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(race_claim_holds.user_id, userId),
        eq(race_claim_holds.race_type, validRaceType),
        eq(race_claim_holds.race_period_start, periodDate),
        isNull(race_claim_holds.released_at),
      ),
    )
    .returning({ id: race_claim_holds.id });
  if (updated.length === 0) {
    throw new Error("No active claim hold to release");
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_claim_unfrozen",
    targetUserId: userId,
    metadata: {
      race_type: raceType,
      race_period_start: periodStart,
      release_reason: releaseReason?.trim() || null,
    },
  });

  revalidatePath("/rewards");
}
