import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Withdrawal lock after at least two distinct free/sponsored battles connect
 * a participant to one or more fraud-flagged creators. Never mutates KYC.
 */

export type RiskyFreeBattleContainmentTarget = {
  userId: string;
  reason: string;
};

function containmentCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10_000
    ? value
    : null;
}

/**
 * Pure admission check — safe inside the ADMIN ingest transaction.
 */
export function riskyFreeBattleContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): RiskyFreeBattleContainmentTarget | null {
  const userId = signal.userId;
  const payload = signal.payload ?? {};
  const matchCount = containmentCount(payload.matchCount);
  const battleCount = containmentCount(payload.qualifyingBattleCount);
  const creatorCount = containmentCount(payload.distinctFlaggedCreators);
  if (
    !userId ||
    signal.riskScore == null ||
    signal.riskScore < 80 ||
    payload.containmentRequired !== true ||
    matchCount == null ||
    matchCount < 2 ||
    battleCount == null ||
    battleCount < 2 ||
    creatorCount == null ||
    creatorCount < 1
  ) {
    return null;
  }

  return {
    userId,
    reason: (
      `Automatic fraud lock: joined ${battleCount} free/sponsored battles ` +
      `created by ${creatorCount} flagged fraud account` +
      `${creatorCount === 1 ? "" : "s"}`
    ).slice(0, 500),
  };
}

export async function applyRiskyFreeBattleContainment(
  target: RiskyFreeBattleContainmentTarget,
): Promise<"locked" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id,
      user_id,
      locked_withdrawals_crypto,
      locked_withdrawals_items,
      locked_withdrawals_at,
      locked_withdrawals_by,
      locked_withdrawals_reason,
      created_at,
      updated_at
    )
    SELECT
      ${crypto.randomUUID()},
      u.id,
      ARRAY['all']::text[],
      TRUE,
      NOW(),
      NULL,
      ${target.reason},
      NOW(),
      NOW()
    FROM "user" u
    WHERE u.id = ${target.userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(
        user_feature_locks.locked_withdrawals_at,
        EXCLUDED.locked_withdrawals_at
      ),
      locked_withdrawals_reason = COALESCE(
        user_feature_locks.locked_withdrawals_reason,
        EXCLUDED.locked_withdrawals_reason
      ),
      updated_at = NOW()
    RETURNING user_id
  `);
  return locked.rows.length > 0 ? "locked" : "skipped";
}
