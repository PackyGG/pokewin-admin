"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import type { race_type } from "@/generated/prisma/enums";

const VALID_RACE_TYPES = new Set<race_type>(["daily", "weekly", "monthly"]);

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
  const db = await getDb();
  const session = await requireAdmin();

  if (!VALID_RACE_TYPES.has(raceType as race_type)) {
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

  const existing = await db.race_prize_tiers.findFirst({
    where: { race_type: raceType as race_type, position },
    select: { id: true, prize_amount_usd: true },
  });

  if (existing) {
    await db.race_prize_tiers.update({
      where: { id: existing.id },
      data: { prize_amount_usd: prizeAmountUsd },
    });
  } else {
    await db.race_prize_tiers.create({
      data: {
        race_type: raceType as race_type,
        position,
        prize_amount_usd: prizeAmountUsd,
      },
    });
  }

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

  revalidatePath("/rewards/leaderboards");
}

/**
 * Bulk-upsert race prize tiers. Used by the "Add Multiple" flow on
 * the Prize Tiers tab so an admin can stage a whole podium worth of
 * positions and persist them in a single click instead of saving
 * after every row.
 *
 * Atomicity: all-or-nothing via `$transaction` — a bad row in the
 * middle (duplicate position, negative amount, etc.) rolls back any
 * partial work, so the table on screen never gets stuck with half a
 * podium applied. Validation runs UP FRONT before we touch the DB so
 * a typo doesn't even open a transaction.
 */
export async function upsertRacePrizeTiersBulk(
  raceType: string,
  rows: { position: number; prizeAmountUsd: number }[],
) {
  const db = await getDb();
  const session = await requireAdmin();

  if (!VALID_RACE_TYPES.has(raceType as race_type)) {
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
  const existing = await db.race_prize_tiers.findMany({
    where: {
      race_type: raceType as race_type,
      position: { in: rows.map((r) => r.position) },
    },
    select: { id: true, position: true, prize_amount_usd: true },
  });
  const existingByPosition = new Map(existing.map((e) => [e.position, e]));

  const operations = rows.map((row) => {
    const prior = existingByPosition.get(row.position);
    if (prior) {
      return db.race_prize_tiers.update({
        where: { id: prior.id },
        data: { prize_amount_usd: row.prizeAmountUsd },
      });
    }
    return db.race_prize_tiers.create({
      data: {
        race_type: raceType as race_type,
        position: row.position,
        prize_amount_usd: row.prizeAmountUsd,
      },
    });
  });

  await db.$transaction(operations);

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

  revalidatePath("/rewards/leaderboards");
  return { upserted: rows.length };
}

/**
 * Remove a race prize tier. Used when an admin wants to stop awarding
 * a specific position — e.g. dropping weekly #10 after shrinking the
 * podium. Deletion is hard; no soft-delete column on the table.
 */
export async function deleteRacePrizeTier(id: string) {
  const db = await getDb();
  const session = await requireAdmin();

  const existing = await db.race_prize_tiers.findUnique({
    where: { id },
    select: { race_type: true, position: true, prize_amount_usd: true },
  });
  if (!existing) {
    throw new Error("Prize tier not found");
  }

  await requireCapability(
    session,
    "__can_delete_race_prize_tier",
    "delete race prize tiers",
  );

  await db.race_prize_tiers.delete({ where: { id } });

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

  revalidatePath("/rewards/leaderboards");
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
 */
export async function startRacePeriod(params: {
  raceType: string;
  startsAt: string;
  endsAt: string;
  autoRenew: boolean;
}) {
  const db = await getDb();
  const session = await requireAdmin();

  const { raceType, startsAt, endsAt, autoRenew } = params;

  if (!VALID_RACE_TYPES.has(raceType as race_type)) {
    throw new Error("Invalid race type (must be daily, weekly, or monthly)");
  }

  const startsAtDate = new Date(startsAt);
  const endsAtDate = new Date(endsAt);
  if (Number.isNaN(startsAtDate.getTime())) {
    throw new Error("Invalid start date");
  }
  if (Number.isNaN(endsAtDate.getTime())) {
    throw new Error("Invalid end date");
  }
  if (endsAtDate <= startsAtDate) {
    throw new Error("End date must be after start date");
  }

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  // Reject if an active period already exists for this type. A clearer
  // error than waiting for the partial unique index to fire.
  const existing = await db.race_periods.findFirst({
    where: { race_type: raceType as race_type, status: "active" },
    select: { id: true, ends_at: true },
  });
  if (existing) {
    throw new Error(
      `An active ${raceType} period already exists (ends ${existing.ends_at.toISOString()}). End it first.`,
    );
  }

  const created = await db.race_periods.create({
    data: {
      race_type: raceType as race_type,
      starts_at: startsAtDate,
      ends_at: endsAtDate,
      auto_renew: autoRenew,
      status: "active",
    },
  });

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

  revalidatePath("/rewards/leaderboards");
}

/**
 * Toggle auto_renew on a period. The backend's lazy rollover honors this
 * when the period ends: true → insert next period, false → leave dormant
 * until an admin starts a new one.
 */
export async function toggleRacePeriodAutoRenew(periodId: string) {
  const db = await getDb();
  const session = await requireAdmin();

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const existing = await db.race_periods.findUnique({
    where: { id: periodId },
    select: { id: true, race_type: true, auto_renew: true, status: true },
  });
  if (!existing) {
    throw new Error("Race period not found");
  }

  const next = !existing.auto_renew;
  await db.race_periods.update({
    where: { id: periodId },
    data: { auto_renew: next },
  });

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

  revalidatePath("/rewards/leaderboards");
}

/**
 * Force-end an active period right now. Snapshots are generated inline
 * (same SUM/GROUP BY the backend uses on lazy rollover) so the period's
 * leaderboard freezes and prizes become claimable. We do NOT auto-create
 * the next period here — even when auto_renew is on, an explicit "end now"
 * is treated as an admin pause; the next period starts when admin says so.
 */
export async function endRacePeriodNow(periodId: string) {
  const db = await getDb();
  const session = await requireAdmin();

  await requireCapability(
    session,
    "__can_manage_race_periods",
    "manage race periods",
  );

  const existing = await db.race_periods.findUnique({
    where: { id: periodId },
    select: {
      id: true,
      race_type: true,
      starts_at: true,
      ends_at: true,
      status: true,
    },
  });
  if (!existing) {
    throw new Error("Race period not found");
  }
  if (existing.status !== "active") {
    throw new Error("Period is not active");
  }

  const periodStartIso = existing.starts_at.toISOString().slice(0, 10);

  await db.$transaction(async (tx) => {
    // Snapshot generation: aggregate game_sessions over the period range,
    // assign dense_rank, exclude bots and ineligible roles. Mirrors
    // RaceSnapshotRepository.generateSnapshotsForPeriod in the backend.
    await tx.$executeRawUnsafe(
      `
      INSERT INTO race_leaderboard_snapshots
        (user_id, race_type, period_start, period_end, position, wagered_usd)
      SELECT
        w.user_id,
        $1::race_type,
        $2::date,
        $3::timestamp,
        dense_rank() OVER (ORDER BY w.wagered_usd::decimal DESC),
        w.wagered_usd
      FROM (
        SELECT
          gs.user_id,
          SUM(gs.bet_amount) AS wagered_usd
        FROM game_sessions gs
        INNER JOIN "user" u ON u.id = gs.user_id
        WHERE gs.user_id IS NOT NULL
          AND gs.created_at >= $4
          AND gs.created_at < $5
          AND (u.role IS NULL OR u.role NOT IN ('admin', 'creator', 'support'))
        GROUP BY gs.user_id
      ) w
      ON CONFLICT (user_id, race_type, period_start) DO NOTHING;
      `,
      existing.race_type,
      periodStartIso,
      existing.ends_at,
      existing.starts_at,
      existing.ends_at,
    );

    await tx.race_periods.update({
      where: { id: periodId },
      data: { status: "ended" },
    });
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_period_ended",
    metadata: {
      period_id: periodId,
      race_type: existing.race_type,
      starts_at: existing.starts_at.toISOString(),
      ends_at: existing.ends_at.toISOString(),
    },
  });

  revalidatePath("/rewards/leaderboards");
}
