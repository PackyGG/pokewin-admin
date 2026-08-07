import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Deterministic MAIN containment for `fiat_blacklisted_email_domain`.
 * Active blocked domains ban and coordinated clusters lock withdrawals.
 * Gmail dot-fragment signals alone are review-only. Automated signals never
 * mutate KYC.
 *
 * Split into a pure validator (`emailDomainContainmentTarget`) and the MAIN
 * write (`applyEmailDomainContainment`) so admission can run inside the ADMIN
 * ingest transaction while MAIN work runs only after commit via the outbox.
 */

export type EmailDomainContainmentTarget = {
  userId: string;
  domain: string;
  reason: string;
  /** Active blocked domain → ban; pattern/cluster → lock only. */
  ban: boolean;
};

function blacklistDomainFromPayload(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  const value = payload?.emailDomain;
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) &&
    domain.includes(".")
    ? domain
    : null;
}

/**
 * Validate a containment signal and build the target, or return null.
 * Pure — safe inside the ADMIN ingest transaction (no MAIN I/O).
 */
export function emailDomainContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): EmailDomainContainmentTarget | null {
  const userId = signal.userId;
  const domain = blacklistDomainFromPayload(signal.payload);
  const patternMatch =
    signal.payload?.emailRiskType === "gmail_dot_fragmentation";
  if (!userId || !domain || signal.riskScore !== 100 || patternMatch) {
    return null;
  }

  const payload = signal.payload ?? {};
  const source = payload.matchSource === "signup" ? "signup" : "Whop checkout";
  const clusterMatch = payload.emailRiskType === "suspicious_deposit_cluster";
  const blockedDomainMatch = payload.emailRiskType === "blacklisted_domain";
  const reason = (
    clusterMatch
      ? `Automatic fraud lock: ${source} belonged to a suspicious coordinated deposit cluster (${domain})`
      : patternMatch
        ? `Automatic fraud lock: ${source} used a suspicious dot-fragmented Gmail address (${domain})`
        : `Automatic fraud ban: ${source} used active blocked email domain ${domain}`
  ).slice(0, 500);

  return {
    userId,
    domain,
    reason,
    ban: blockedDomainMatch,
  };
}

/**
 * Apply the lock (and ban when `target.ban`) in MAIN. COALESCE on `*_at` /
 * `*_reason` / ban fields so retries never overwrite the first reason.
 *
 * `"banned"` and `"locked"` both mean containment was applied; the outbox
 * maps both to `"locked"` / `applied`. `"skipped"` is permanent (account gone).
 */
export async function applyEmailDomainContainment(
  target: EmailDomainContainmentTarget,
): Promise<"banned" | "locked" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const contained = await db.transaction(async (tx) => {
    const locked = await tx.execute<{ user_id: string }>(sql`
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
    if (locked.rows.length === 0 || !target.ban) {
      return locked.rows.length > 0;
    }

    await tx.execute(sql`
      UPDATE "user"
      SET
        is_banned = TRUE,
        banned_reason = CASE
          WHEN is_banned THEN COALESCE(banned_reason, ${target.reason})
          ELSE ${target.reason}
        END,
        banned_at = CASE
          WHEN is_banned THEN COALESCE(banned_at, NOW())
          ELSE NOW()
        END,
        banned_by = CASE WHEN is_banned THEN banned_by ELSE NULL END,
        updated_at = NOW()
      WHERE id = ${target.userId}
    `);
    await tx.execute(sql`DELETE FROM session WHERE "userId" = ${target.userId}`);
    return true;
  });

  if (!contained) return "skipped";
  return target.ban ? "banned" : "locked";
}
