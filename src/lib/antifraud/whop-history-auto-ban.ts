import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

const PAYMENT_ID = /^pay_[A-Za-z0-9]+$/;
const INTENT_ID = /^[0-9a-f-]{36}$/i;

export type WhopHistoryAutoBanTarget = {
  userId: string;
  paymentId: string;
  depositIntentId: string;
  priorDisputeCount: number;
  priorRefundCount: number;
  reason: string;
};

function positiveCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 1_000_000)
    : null;
}

/** Pure fail-closed admission check for signed monitor commands. */
export function whopHistoryAutoBanTarget(signal: {
  userId?: string | null;
  riskScore?: number | null;
  payload?: Record<string, unknown> | null;
}): WhopHistoryAutoBanTarget | null {
  const payload = signal.payload ?? {};
  const userId = signal.userId?.trim();
  const paymentId =
    typeof payload.paymentId === "string" ? payload.paymentId.trim() : "";
  const depositIntentId =
    typeof payload.depositIntentId === "string"
      ? payload.depositIntentId.trim()
      : "";
  const priorDisputeCount = positiveCount(payload.priorDisputeCount);
  const priorRefundCount = positiveCount(payload.priorRefundCount);
  if (
    !userId ||
    userId.length > 128 ||
    signal.riskScore !== 100 ||
    payload.containmentRequired !== true ||
    payload.containmentAction !== "ban" ||
    payload.environment !== "prod" ||
    payload.provider !== "whop" ||
    !PAYMENT_ID.test(paymentId) ||
    !INTENT_ID.test(depositIntentId) ||
    priorDisputeCount === null ||
    priorRefundCount === null ||
    priorDisputeCount + priorRefundCount === 0
  ) {
    return null;
  }

  const reason = (
    "Automatic Whop history ban: buyer history reports " +
    `${priorDisputeCount} prior dispute(s) and ` +
    `${priorRefundCount} prior refund(s); payment ${paymentId}`
  ).slice(0, 500);
  return {
    userId,
    paymentId,
    depositIntentId,
    priorDisputeCount,
    priorRefundCount,
    reason,
  };
}

/**
 * Idempotently ban the Packy account and revoke every active session. An
 * already-banned account is skipped so the automation never overwrites a
 * human or earlier system ban reason and never claims somebody else's ban —
 * with one exception: a ban this very automation already placed is reported as
 * `"banned"` again, because the guarded UPDATE cannot tell "somebody else got
 * here first" from "my own outcome write was lost and I am being retried".
 */
export async function applyWhopHistoryAutoBan(
  target: WhopHistoryAutoBanTarget,
): Promise<"banned" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE "user"
      SET
        is_banned = TRUE,
        banned_reason = ${target.reason},
        banned_at = NOW(),
        banned_by = NULL,
        updated_at = NOW()
      WHERE id = ${target.userId}
        AND is_banned = FALSE
        AND COALESCE(role::text, '') NOT IN ('admin', 'support', 'creator')
        AND NOT COALESCE(roles::text[], ARRAY[]::text[])
          && ARRAY['admin','support','creator']::text[]
      RETURNING id
    `);
    if (result.rows.length !== 1) {
      // Zero rows means "already banned", "missing", or "staff" — and on a
      // retry the common cause is this automation's OWN earlier ban whose
      // outcome write never landed. Reporting that as skipped left the outbox
      // status `skipped` and `containment_applied_at` NULL, so Auto Bans
      // rendered a "Skipped" badge with no ban time for an account that really
      // is banned. `banned_by IS NULL` plus the exact reason string (it carries
      // this payment id) can only ever match our own ban, so the "never claim
      // somebody else's ban" contract still holds.
      const priorAutoBan = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM "user"
        WHERE id = ${target.userId}
          AND is_banned = TRUE
          AND banned_by IS NULL
          AND banned_reason = ${target.reason}
      `);
      if (priorAutoBan.rows.length !== 1) return "skipped";
    }
    await tx.execute(sql`
      DELETE FROM session WHERE "userId" = ${target.userId}
    `);
    return "banned";
  });
}
