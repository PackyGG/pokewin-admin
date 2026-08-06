import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Withdrawal lock for `signup_policy_recommendation` when signup matched an
 * active IP or fingerprint blocklist rule. Never mutates KYC.
 */

export type IdentifierBlocklistContainmentTarget = {
  userId: string;
  reason: string;
};

/**
 * Pure admission check — safe inside the ADMIN ingest transaction.
 */
export function identifierBlocklistContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): IdentifierBlocklistContainmentTarget | null {
  const policies = signal.payload?.policyMatches;
  const matched =
    Array.isArray(policies) &&
    policies.some(
      (policy) => policy === "blocklist.ip" || policy === "blocklist.fingerprint",
    );
  if (!signal.userId || signal.riskScore !== 100 || !matched) {
    return null;
  }

  return {
    userId: signal.userId,
    reason: (
      "Automatic fraud lock: signup matched an active operator-managed " +
      "IP or fingerprint blocklist rule"
    ).slice(0, 500),
  };
}

export async function applyIdentifierBlocklistContainment(
  target: IdentifierBlocklistContainmentTarget,
): Promise<"locked" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const locked = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id, locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason, created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id, ARRAY['all']::text[], TRUE, NOW(), NULL,
      ${target.reason}, NOW(), NOW()
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
