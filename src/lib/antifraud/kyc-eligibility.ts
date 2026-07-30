import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * KYC may be added only as a staff decision for an account whose balance and
 * item withdrawals are both currently locked. This primary read is part of
 * the mutation eligibility check, not an ordinary dashboard read.
 */
export async function isLockedAccountEligibleForKyc(
  userId: string,
): Promise<boolean> {
  const result = await getProdPrimaryDrizzleDb().execute<{ eligible: boolean }>(
    sql`
      SELECT EXISTS (
        SELECT 1
        FROM user_feature_locks
        WHERE user_id = ${userId}
          AND locked_withdrawals_items = TRUE
          AND COALESCE(cardinality(locked_withdrawals_crypto), 0) > 0
      ) AS eligible
    `,
  );
  return result.rows[0]?.eligible === true;
}
