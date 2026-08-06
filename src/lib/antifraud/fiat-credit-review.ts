import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import type { FiatAssessment } from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

export type FiatCreditReviewState =
  | "active"
  | "approving"
  | "approval_failed"
  | "approved"
  | "containing"
  | "containment_failed"
  | "declined"
  | "resolving"
  | "resolution_failed"
  | "resolved";

export type DeclinedFiatCreditReview = {
  id: string;
  depositIntentId: string;
  userId: string;
  providerPaymentId: string;
  currency: string;
  amountCents: number;
  customerTotalCents: number | null;
  status: FiatCreditReviewState;
  decisionReason: string;
  decidedByUsername: string | null;
  decidedAt: string;
  containedAt: string | null;
  containmentError: string | null;
  resolutionAction: "refund" | "ban" | "refund_and_ban" | null;
  resolutionReason: string | null;
  refundStatus: string;
  banStatus: string;
  lastError: string | null;
  resolvedAt: string | null;
  version: number;
};

export async function getFiatCreditReviewStates(
  intentIds: readonly string[],
): Promise<Map<string, FiatCreditReviewState>> {
  const ids = [...new Set(intentIds)];
  if (ids.length === 0) return new Map();
  const result = await adminDrizzle.execute<{
    deposit_intent_id: string;
    status: FiatCreditReviewState;
  }>(sql`
    SELECT deposit_intent_id::text, status
    FROM admin_fiat_credit_reviews
    WHERE deposit_intent_id = ANY(${pgArrayParam(ids)}::uuid[])
  `);
  return new Map(result.rows.map((row) => [row.deposit_intent_id, row.status]));
}

export async function getDeclinedFiatCreditReviews(): Promise<
  DeclinedFiatCreditReview[]
> {
  await requireAntifraudManager(
    "Only owners and admins can view declined Fiat deposits.",
  );
  const result = await adminDrizzle.execute<{
    id: string;
    deposit_intent_id: string;
    user_id: string;
    provider_payment_id: string;
    currency: string;
    amount_cents: number;
    customer_total_cents: number | null;
    status: FiatCreditReviewState;
    decision_reason: string;
    decided_by_username: string | null;
    decided_at: string;
    contained_at: string | null;
    containment_error: string | null;
    resolution_action: "refund" | "ban" | "refund_and_ban" | null;
    resolution_reason: string | null;
    refund_status: string;
    ban_status: string;
    last_error: string | null;
    resolved_at: string | null;
    version: number;
  }>(sql`
    SELECT
      review.id::text,
      review.deposit_intent_id::text,
      review.user_id,
      review.provider_payment_id,
      review.currency,
      review.amount_cents,
      review.customer_total_cents,
      review.status,
      review.decision_reason,
      actor.username AS decided_by_username,
      review.decided_at::text,
      review.contained_at::text,
      review.containment_error,
      review.resolution_action,
      review.resolution_reason,
      review.refund_status,
      review.ban_status,
      review.last_error,
      review.resolved_at::text,
      review.version
    FROM admin_fiat_credit_reviews review
    LEFT JOIN admin_users actor ON actor.id = review.decided_by
    WHERE review.staff_decision = 'decline'
    ORDER BY
      (review.status IN ('declined', 'containment_failed', 'resolution_failed', 'resolving')) DESC,
      review.decided_at DESC,
      review.id DESC
    LIMIT 500
  `);
  return result.rows.map((row) => ({
    id: row.id,
    depositIntentId: row.deposit_intent_id,
    userId: row.user_id,
    providerPaymentId: row.provider_payment_id,
    currency: row.currency,
    amountCents: Number(row.amount_cents),
    customerTotalCents:
      row.customer_total_cents == null ? null : Number(row.customer_total_cents),
    status: row.status,
    decisionReason: row.decision_reason,
    decidedByUsername: row.decided_by_username,
    decidedAt: row.decided_at,
    containedAt: row.contained_at,
    containmentError: row.containment_error,
    resolutionAction: row.resolution_action,
    resolutionReason: row.resolution_reason,
    refundStatus: row.refund_status,
    banStatus: row.ban_status,
    lastError: row.last_error,
    resolvedAt: row.resolved_at,
    version: row.version,
  }));
}

export function assessmentSnapshot(assessment: FiatAssessment) {
  if (!assessment.provider_payment_id) {
    throw new Error("This reviewed deposit has no Whop payment id.");
  }
  return {
    depositIntentId: assessment.deposit_intent_id,
    userId: assessment.user_id,
    provider: assessment.provider,
    providerPaymentId: assessment.provider_payment_id,
    currency: assessment.currency.toLowerCase(),
    amountCents: Math.round(assessment.credited_amount_usd * 100),
    customerTotalCents:
      assessment.customer_total_usd == null
        ? null
        : Math.round(assessment.customer_total_usd * 100),
  };
}

export async function lockFiatAndWithdrawals(input: {
  userId: string;
  actorMainUserId: string | null;
  reason: string;
}): Promise<void> {
  const db = await getPrimaryDrizzleDb();
  const result = await db.execute<{ user_id: string }>(sql`
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
      ${crypto.randomUUID()}::uuid, account.id,
      ARRAY['all']::text[], NOW(), ${input.actorMainUserId}, ${input.reason},
      ARRAY['all']::text[], TRUE, NOW(), ${input.actorMainUserId}, ${input.reason},
      NOW(), NOW()
    FROM "user" account
    WHERE account.id = ${input.userId}
    ON CONFLICT (user_id) DO UPDATE SET
      locked_deposits_fiat = ARRAY['all']::text[],
      locked_deposits_at = COALESCE(user_feature_locks.locked_deposits_at, NOW()),
      locked_deposits_by = COALESCE(user_feature_locks.locked_deposits_by, ${input.actorMainUserId}),
      locked_deposits_reason = COALESCE(user_feature_locks.locked_deposits_reason, ${input.reason}),
      locked_withdrawals_crypto = ARRAY['all']::text[],
      locked_withdrawals_items = TRUE,
      locked_withdrawals_at = COALESCE(user_feature_locks.locked_withdrawals_at, NOW()),
      locked_withdrawals_by = COALESCE(user_feature_locks.locked_withdrawals_by, ${input.actorMainUserId}),
      locked_withdrawals_reason = COALESCE(user_feature_locks.locked_withdrawals_reason, ${input.reason}),
      updated_at = NOW()
    RETURNING user_id
  `);
  if (result.rows.length !== 1) throw new Error("The player account no longer exists.");
}

export async function creditReviewedFiatDeposit(input: {
  depositIntentId: string;
  providerPaymentId: string;
  userId: string;
  amountCents: number;
  customerTotalCents: number | null;
  providerStatus: string;
  reviewedBy: string;
  reason: string;
}): Promise<void> {
  const db = await getPrimaryDrizzleDb();
  const amount = (input.amountCents / 100).toFixed(2);
  const ledgerId = crypto.randomUUID();
  const coinLedgerId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    const intent = (await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      provider_payment_id: string | null;
      completed_ledger_id: string | null;
    }>(sql`
      SELECT id::text, user_id, status, provider_payment_id, completed_ledger_id::text
      FROM fiat_deposit_intents
      WHERE id = ${input.depositIntentId}::uuid
      FOR UPDATE
    `)).rows[0];
    if (!intent) throw new Error("The Fiat deposit no longer exists.");
    if (intent.status === "completed") return;
    if (intent.status !== "review") {
      throw new Error("This Fiat deposit is no longer awaiting a decision.");
    }
    if (intent.user_id !== input.userId) throw new Error("The deposit owner changed.");
    if (intent.provider_payment_id !== input.providerPaymentId) {
      throw new Error("The deposit is linked to a different Whop payment.");
    }

    let wagerBps = 10_000;
    const config = (await tx.execute<{ value: unknown }>(sql`
      SELECT value FROM site_config
      WHERE key = 'withdrawal_wager_requirement_bps'
      LIMIT 1
    `)).rows[0];
    const configured = Number(config?.value);
    if (Number.isFinite(configured) && configured >= 0) wagerBps = Math.round(configured);
    const override = (await tx.execute<{ wager_requirement_bps: number | null }>(sql`
      SELECT wager_requirement_bps
      FROM user_wager_requirements
      WHERE user_id = ${input.userId}
      LIMIT 1
    `)).rows[0]?.wager_requirement_bps;
    if (override != null && Number.isFinite(override) && override >= 0) {
      wagerBps = Math.round(override);
    }

    await tx.execute(sql`
      INSERT INTO balances (id, user_id, available_balance, locked_balance, total_deposited, total_withdrawn, shards, version, created_at, updated_at)
      VALUES (${crypto.randomUUID()}::uuid, ${input.userId}, 0, 0, 0, 0, 0, 1, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `);
    const balance = (await tx.execute<{
      available_balance: string;
      coin_available_balance: string;
    }>(sql`
      SELECT available_balance::text, coin_available_balance::text
      FROM balances
      WHERE user_id = ${input.userId}
      FOR UPDATE
    `)).rows[0];
    if (!balance) throw new Error("The player balance could not be loaded.");

    const existingLedger = (await tx.execute<{
      id: string;
      status: string;
      user_id: string;
    }>(sql`
      SELECT id::text, status::text, user_id
      FROM ledger_transactions
      WHERE external_tx_id = ${input.providerPaymentId}
      LIMIT 1
      FOR UPDATE
    `)).rows[0];
    if (existingLedger?.status === "completed") {
      if (existingLedger.user_id !== input.userId) {
        throw new Error("That Whop payment is already assigned to another player.");
      }
      await tx.execute(sql`
        UPDATE fiat_deposit_intents
        SET status = 'completed', completed_ledger_id = ${existingLedger.id}::uuid,
            review_decision = 'approved', reviewed_by = ${input.reviewedBy},
            review_reason = ${input.reason}, reviewed_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = ${input.depositIntentId}::uuid
      `);
      return;
    }
    if (existingLedger) throw new Error("A non-final ledger entry already uses this Whop payment.");

    const availableBefore = Number(balance.available_balance);
    const coinBefore = Number(balance.coin_available_balance);
    const availableAfter = (availableBefore + input.amountCents / 100).toFixed(2);
    const coinAfter = (coinBefore + input.amountCents / 100).toFixed(2);
    await tx.execute(sql`
      INSERT INTO ledger_transactions (
        id, user_id, type, amount, balance_before, balance_after,
        crypto_asset, external_tx_id, description, metadata, status, created_at, updated_at
      ) VALUES (
        ${ledgerId}::uuid, ${input.userId}, 'deposit', ${amount}::numeric,
        ${balance.available_balance}::numeric, ${availableAfter}::numeric,
        'FIAT', ${input.providerPaymentId}, ${`Whop deposit of $${amount}`},
        ${JSON.stringify({
          provider: "whop",
          deposit_intent_id: input.depositIntentId,
          gross_cents: input.customerTotalCents,
          approved_by_admin_user_id: input.reviewedBy,
        })}::jsonb,
        'completed', NOW(), NOW()
      )
    `);
    await tx.execute(sql`
      UPDATE balances
      SET available_balance = ${availableAfter}::numeric,
          coin_available_balance = ${coinAfter}::numeric,
          total_deposited = total_deposited + ${amount}::numeric,
          wager_requirement_remaining = COALESCE(wager_requirement_remaining, 0) + (${amount}::numeric * ${wagerBps}::numeric / 10000),
          last_transaction_id = ${ledgerId}::uuid,
          version = version + 1,
          updated_at = NOW()
      WHERE user_id = ${input.userId}
    `);
    await tx.execute(sql`
      INSERT INTO coin_transactions (
        id, user_id, type, amount, balance_before, balance_after,
        description, metadata, created_at, updated_at
      ) VALUES (
        ${coinLedgerId}::uuid, ${input.userId}, 'coin_deposit_grant', ${amount}::numeric,
        ${balance.coin_available_balance}::numeric, ${coinAfter}::numeric,
        ${`Coin grant for $${amount} Whop deposit.`},
        ${JSON.stringify({ deposit_ledger_id: ledgerId })}::jsonb,
        NOW(), NOW()
      )
    `);
    await tx.execute(sql`
      UPDATE fiat_deposit_intents
      SET status = 'completed', provider_payment_status = ${input.providerStatus},
          completed_ledger_id = ${ledgerId}::uuid,
          review_decision = 'approved', reviewed_by = ${input.reviewedBy},
          review_reason = ${input.reason}, reviewed_at = NOW(),
          failure_reason = NULL, completed_at = NOW(), updated_at = NOW()
      WHERE id = ${input.depositIntentId}::uuid AND status = 'review'
    `);
  });
}
