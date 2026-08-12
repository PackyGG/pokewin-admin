import "server-only";

import { sql } from "drizzle-orm";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Automatic locks for high-confidence post-authorization Fiat fraud.
 * Identity signals never require KYC automatically; KYC remains a staff
 * decision in Account Review.
 */

export const FIAT_IDENTITY_CONTAINMENT_REASONS = new Set([
  "checkout_email_domain_blacklisted",
  "checkout_ip_blocklisted",
  "checkout_fingerprint_blocklisted",
  "checkout_refunded_amount_cluster",
  "checkout_card_changed_recent",
  "checkout_ip_and_device_changed",
]);

export type FiatIdentityContainmentTarget = {
  userId: string;
  intentId: string;
  reasons: string[];
  reason: string;
  action: "withdrawals" | "fiat_and_withdrawals";
  /** Active high-confidence refunded-amount campaigns are automatic bans. */
  ban: boolean;
};

/** Pure admission validation; safe inside the ADMIN ingest transaction. */
export function fiatIdentityContainmentTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): FiatIdentityContainmentTarget | null {
  const userId = signal.userId;
  const payload = signal.payload ?? {};
  const clusterActiveUntil =
    typeof payload.refundedAmountClusterActiveUntil === "string"
      ? Date.parse(payload.refundedAmountClusterActiveUntil)
      : Number.NaN;
  const rawReasons = payload.reasonCodes;
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((reason): reason is string => {
        if (
          typeof reason !== "string"
          || !FIAT_IDENTITY_CONTAINMENT_REASONS.has(reason)
        ) {
          return false;
        }
        return reason !== "checkout_refunded_amount_cluster"
          || (Number.isFinite(clusterActiveUntil)
            && clusterActiveUntil > Date.now());
      })
    : [];
  const intentId =
    typeof payload.intentId === "string" ? payload.intentId : null;
  const action =
    payload.containmentAction === "withdrawals"
      || payload.containmentAction === "fiat_and_withdrawals"
      ? payload.containmentAction
      : null;
  if (
    !userId
    || !intentId
    || !action
    || payload.containmentRequired !== true
    || payload.environment !== "prod"
    || signal.riskScore == null
    || signal.riskScore < 70
    || signal.riskScore > 100
    || reasons.length === 0
  ) {
    return null;
  }

  const ban = reasons.includes("checkout_refunded_amount_cluster");
  return {
    userId,
    intentId,
    reasons,
    action,
    ban,
    reason: (
      `${ban ? "Automatic fraud ban" : "Automatic fraud lock"}: high-confidence authorized Fiat risk (`
      + `${reasons.join(", ")})`
    ).slice(0, 500),
  };
}

export type FiatIdentityContainmentOutcome = { locked: boolean; banned: boolean };

/** Apply approved rail locks; refunded-amount campaigns also ban and revoke sessions. */
export async function applyFiatIdentityContainment(
  target: FiatIdentityContainmentTarget,
): Promise<FiatIdentityContainmentOutcome> {
  const db = getProdPrimaryDrizzleDb();
  const outcome = await db.transaction(async (tx): Promise<FiatIdentityContainmentOutcome> => {
    const locked = target.action === "withdrawals"
      ? await tx.execute<{ user_id: string }>(sql`
      INSERT INTO user_feature_locks (
        id, user_id,
        locked_withdrawals_crypto, locked_withdrawals_items,
        locked_withdrawals_at, locked_withdrawals_by,
        locked_withdrawals_reason, created_at, updated_at
      )
      SELECT
        ${crypto.randomUUID()}, u.id,
        ARRAY['all']::text[], TRUE, NOW(), NULL, ${target.reason}, NOW(), NOW()
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
    `)
      : await tx.execute<{ user_id: string }>(sql`
    INSERT INTO user_feature_locks (
      id, user_id,
      locked_deposits_fiat, locked_deposits_at, locked_deposits_by,
      locked_deposits_reason,
      locked_withdrawals_crypto, locked_withdrawals_items,
      locked_withdrawals_at, locked_withdrawals_by,
      locked_withdrawals_reason,
      created_at, updated_at
    )
    SELECT
      ${crypto.randomUUID()}, u.id,
      ARRAY['all']::text[], NOW(), NULL, ${target.reason},
      ARRAY['all']::text[], TRUE, NOW(), NULL, ${target.reason},
      NOW(), NOW()
    FROM "user" u
    WHERE u.id = ${target.userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_deposits_fiat = ARRAY['all']::text[],
      locked_deposits_at = COALESCE(
        user_feature_locks.locked_deposits_at,
        EXCLUDED.locked_deposits_at
      ),
      locked_deposits_reason = COALESCE(
        user_feature_locks.locked_deposits_reason,
        EXCLUDED.locked_deposits_reason
      ),
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
      return { locked: locked.rows.length > 0, banned: false };
    }

    const banned = await tx.execute<{ id: string }>(sql`
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
        AND is_banned = FALSE
        AND COALESCE(role::text, '') NOT IN ('admin', 'support', 'creator')
        AND NOT COALESCE(roles::text[], ARRAY[]::text[])
          && ARRAY['admin','support','creator']::text[]
      RETURNING id
    `);
    if (banned.rows.length === 1) {
      await tx.execute(sql`DELETE FROM session WHERE "userId" = ${target.userId}`);
    }
    return { locked: true, banned: banned.rows.length === 1 };
  });

  // Deliberately after the MAIN transaction commits: the audit mirror is an
  // ADMIN-DB round trip that retries for seconds on failure, and holding the
  // contained account's MAIN row locks for that long would put a fraud write
  // in the way of ordinary checkout traffic.
  if (outcome.locked) await recordFiatIdentityContainmentAudit(target, outcome);
  return outcome;
}

/**
 * ADMIN-side record that an unattended system restricted this account.
 *
 * Filed under a dedicated automatic event type, never the staff vocabulary:
 * `antifraud_withdrawals_locked` / `account_banned` are the operator trail
 * ("one row = one staff decision"), and `locked_withdrawals_*_enabled` is read
 * by the critical-signup watchdog as a terminal staff release. Writing either
 * from here would present automation as an operator and stand that watchdog
 * down.
 *
 * `createAdminAuditEventDurable` retries, falls back to
 * `admin_audit_write_failures`, alerts, and never throws — MAIN is already
 * committed at this point, so a failed mirror must not turn an applied
 * containment into an outbox failure that retries the whole apply.
 */
async function recordFiatIdentityContainmentAudit(
  target: FiatIdentityContainmentTarget,
  outcome: FiatIdentityContainmentOutcome,
): Promise<void> {
  await createAdminAuditEventDurable({
    adminUserId: null,
    eventType: outcome.banned
      ? "antifraud_containment_banned"
      : "antifraud_containment_locked",
    targetUserId: target.userId,
    // Explicit null: the only address in scope on this path belongs to the
    // monitor delivering the command, never to the contained account, and an
    // `ip` column that looks like the user's would misdirect a later review.
    ip: null,
    metadata: {
      source: "antifraud_containment",
      kind: "fiat_deposit_identity_containment",
      reasonCodes: target.reasons,
      reason: target.reason,
      action: target.action,
      // Our own deposit-intent id — the signal identifier that ties this row
      // back to the assessment. No provider payload, card or email data.
      intentId: target.intentId,
      banned: outcome.banned,
      sessionsRevoked: outcome.banned,
    },
  });
}
