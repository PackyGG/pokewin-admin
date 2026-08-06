import "server-only";

import type Whop from "@whop/sdk";
import type { PaymentListFeesResponse } from "@whop/sdk/resources/payments";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { whopAdminClient } from "@/lib/whop-admin";
import type { FiatAssessment } from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudManagerRead } from "@/lib/require-antifraud-access";

const PROCESSING_LEASE_MINUTES = 5;
const DEPOSIT_BONUS_RATE_BPS = 500;
const DEFAULT_DEPOSIT_BONUS_PERIOD_HOURS = 6;
const DEFAULT_DEPOSIT_BONUS_CAP_CENTS = 2_500;

type WhopPayment = Awaited<ReturnType<Whop["payments"]["retrieve"]>>;

function effectiveReviewState(
  status: FiatCreditReviewState,
  updatedAt: string,
): FiatCreditReviewState {
  const staleBefore = Date.now() - PROCESSING_LEASE_MINUTES * 60_000;
  if (new Date(updatedAt).getTime() >= staleBefore) return status;
  if (status === "approving") return "approval_failed";
  if (status === "containing") return "containment_failed";
  if (status === "resolving") return "resolution_failed";
  return status;
}

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
    updated_at: string;
  }>(sql`
    SELECT deposit_intent_id::text, status, updated_at::text
    FROM admin_fiat_credit_reviews
    WHERE deposit_intent_id = ANY(${pgArrayParam(ids)}::uuid[])
  `);
  return new Map(
    result.rows.map((row) => [
      row.deposit_intent_id,
      effectiveReviewState(row.status, row.updated_at),
    ]),
  );
}

export async function getDeclinedFiatCreditReviews(): Promise<
  DeclinedFiatCreditReview[]
> {
  // Read gate, not the action gate: this runs during the page render, which has
  // no `Origin` header for the same-origin check to pass.
  await requireAntifraudManagerRead(
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
    updated_at: string;
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
      review.version,
      review.updated_at::text
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
    status: effectiveReviewState(row.status, row.updated_at),
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
  currency: string;
  amountCents: number;
  payment: WhopPayment;
  reviewedBy: string;
  reason: string;
}): Promise<{
  amountCents: number;
  ledgerId: string;
  userId: string;
}> {
  const db = await getPrimaryDrizzleDb();
  const ledgerId = crypto.randomUUID();
  const coinLedgerId = crypto.randomUUID();

  return db.transaction(async (tx) => {
    const intent = (await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      provider_payment_id: string | null;
      completed_ledger_id: string | null;
      currency: string;
      requested_amount_cents: number;
      credited_amount_cents: number;
      pricing_metadata: unknown;
    }>(sql`
      SELECT id::text, user_id, status, provider_payment_id,
             completed_ledger_id::text, currency, requested_amount_cents,
             credited_amount_cents, pricing_metadata
      FROM fiat_deposit_intents
      WHERE id = ${input.depositIntentId}::uuid
      FOR UPDATE
    `)).rows[0];
    if (!intent) throw new Error("The Fiat deposit no longer exists.");
    if (intent.status !== "review" && intent.status !== "completed") {
      throw new Error("This Fiat deposit is no longer awaiting a decision.");
    }
    if (intent.user_id !== input.userId) throw new Error("The deposit owner changed.");
    if (intent.provider_payment_id !== input.providerPaymentId) {
      throw new Error("The deposit is linked to a different Whop payment.");
    }
    if (
      intent.credited_amount_cents !== input.amountCents ||
      intent.currency.toLowerCase() !== input.currency.toLowerCase()
    ) {
      throw new Error("The Antifraud assessment is stale. Refresh before approving.");
    }

    const payment = input.payment;
    if (payment.id !== input.providerPaymentId) {
      throw new Error("Whop returned a different payment.");
    }
    if (payment.metadata?.deposit_intent_id !== input.depositIntentId) {
      throw new Error("The Whop payment is not bound to this deposit intent.");
    }
    if (payment.status !== "paid" || payment.substatus !== "succeeded") {
      throw new Error("The Whop payment is no longer successful.");
    }
    if (
      payment.dispute_alerted_at ||
      (payment.disputes?.length ?? 0) > 0 ||
      (payment.refunded_amount ?? 0) > 0
    ) {
      throw new Error("Refunded or disputed Whop payments cannot be approved.");
    }

    const pricing =
      intent.pricing_metadata && typeof intent.pricing_metadata === "object"
        ? (intent.pricing_metadata as Record<string, unknown>)
        : {};
    const storedChargeCents =
      pricing.quoted_purchase_price_cents ?? pricing.quoted_customer_total_cents;
    const hasStoredPricing =
      Number.isInteger(storedChargeCents) &&
      Number.isInteger(
        pricing.pricing_total_fixed_cost_cents ??
          pricing.processing_fixed_fee_cents,
      ) &&
      Number.isInteger(
        pricing.pricing_markup_bps ?? pricing.processing_fee_bps,
      );
    const chargeCurrency =
      hasStoredPricing && pricing.checkout_currency === "EUR" ? "EUR" : "USD";
    const quotedCents = Number(
      hasStoredPricing ? storedChargeCents : intent.requested_amount_cents,
    );
    if (!Number.isInteger(quotedCents) || quotedCents <= 0) {
      throw new Error("The stored checkout amount is invalid.");
    }
    const paymentRecord = payment as WhopPayment & {
      settlement_amount?: number | null;
    };
    const verifiedTotal =
      chargeCurrency === "EUR"
        ? paymentRecord.settlement_currency?.toUpperCase() === "EUR"
          ? paymentRecord.settlement_amount ??
            (payment.currency.toUpperCase() === "EUR" ? payment.total : null)
          : null
        : payment.usd_total ??
          (payment.currency.toUpperCase() === "USD" ? payment.total : null);
    const verifiedTotalCents =
      verifiedTotal == null ? null : Math.round(verifiedTotal * 100);
    if (verifiedTotalCents !== quotedCents) {
      throw new Error(
        `Whop amount mismatch: expected ${quotedCents} ${chargeCurrency} cents.`,
      );
    }
    const selectedMethod =
      typeof pricing.payment_method === "string"
        ? pricing.payment_method.trim().toLowerCase()
        : null;
    const providerMethod = payment.payment_method_type?.trim().toLowerCase() ?? null;
    const methodMatches =
      selectedMethod === "apple_pay"
        ? providerMethod === "apple_pay" || providerMethod === "apple"
        : selectedMethod == null || providerMethod === selectedMethod;
    if (!methodMatches) {
      throw new Error("The Whop payment method differs from the selected checkout method.");
    }

    const amount = (intent.credited_amount_cents / 100).toFixed(2);
    const providerNetAmountCents = Math.round(payment.amount_after_fees * 100);
    const providerMetadata = JSON.stringify({
      admin_review_credit: true,
      buyer_currency: payment.currency.toUpperCase(),
      buyer_total_cents:
        payment.total == null ? null : Math.round(payment.total * 100),
      checkout_currency: chargeCurrency,
      payment_method_type: payment.payment_method_type,
      provider_net_amount_cents: providerNetAmountCents,
      settlement_currency: payment.settlement_currency?.toUpperCase() ?? null,
      usd_gross_cents:
        payment.usd_total == null ? null : Math.round(payment.usd_total * 100),
    });

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
      const linkedLedger = (await tx.execute<{
        amount: string;
        crypto_asset: string | null;
        deposit_intent_id: string | null;
        type: string;
      }>(sql`
        SELECT amount::text, crypto_asset, type::text,
               metadata->>'deposit_intent_id' AS deposit_intent_id
        FROM ledger_transactions
        WHERE id = ${existingLedger.id}::uuid
      `)).rows[0];
      if (
        !linkedLedger ||
        linkedLedger.type !== "deposit" ||
        linkedLedger.crypto_asset !== "FIAT" ||
        Number(linkedLedger.amount) !== intent.credited_amount_cents / 100 ||
        linkedLedger.deposit_intent_id !== input.depositIntentId
      ) {
        throw new Error("The existing Whop ledger entry conflicts with this deposit.");
      }
      await tx.execute(sql`
        UPDATE fiat_deposit_intents
        SET status = 'completed', completed_ledger_id = ${existingLedger.id}::uuid,
            review_decision = 'approved', reviewed_by = ${input.reviewedBy},
            review_reason = ${input.reason}, reviewed_at = NOW(), completed_at = NOW(),
            actual_customer_total_cents = ${verifiedTotalCents},
            provider_net_amount_cents = ${providerNetAmountCents},
            provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || ${providerMetadata}::jsonb,
            updated_at = NOW()
        WHERE id = ${input.depositIntentId}::uuid
      `);
      return {
        amountCents: intent.credited_amount_cents,
        ledgerId: existingLedger.id,
        userId: input.userId,
      };
    }
    if (existingLedger) throw new Error("A non-final ledger entry already uses this Whop payment.");

    const availableBefore = Number(balance.available_balance);
    const coinBefore = Number(balance.coin_available_balance);
    const availableAfter = (
      availableBefore +
      intent.credited_amount_cents / 100
    ).toFixed(2);
    const coinAfter = (coinBefore + intent.credited_amount_cents / 100).toFixed(2);
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
          gross_cents: verifiedTotalCents,
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
      SET status = 'completed', provider_payment_status = ${payment.substatus},
          completed_ledger_id = ${ledgerId}::uuid,
          actual_customer_total_cents = ${verifiedTotalCents},
          provider_net_amount_cents = ${providerNetAmountCents},
          provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || ${providerMetadata}::jsonb,
          review_decision = 'approved', reviewed_by = ${input.reviewedBy},
          review_reason = ${input.reason}, reviewed_at = NOW(),
          failure_reason = NULL, completed_at = NOW(), updated_at = NOW()
      WHERE id = ${input.depositIntentId}::uuid AND status = 'review'
    `);
    return {
      amountCents: intent.credited_amount_cents,
      ledgerId,
      userId: input.userId,
    };
  });
}

function positiveConfigNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeConfigNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function completeReviewedFiatPostCreditEffects(input: {
  amountCents: number;
  depositIntentId: string;
  ledgerId: string;
  payment: WhopPayment;
  providerPaymentId: string;
  userId: string;
}): Promise<{ affiliateBonusCents: number }> {
  const fees: PaymentListFeesResponse[] = [];
  try {
    for await (const fee of whopAdminClient().payments.listFees(
      input.providerPaymentId,
    )) {
      fees.push(fee);
    }
  } catch (error) {
    console.warn("[fiat-deposit-review] Whop fee sync deferred", {
      error,
      providerPaymentId: input.providerPaymentId,
    });
  }

  const db = await getPrimaryDrizzleDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`reviewed-fiat-effects:${input.userId}`}, 0))
    `);
    const creditedDeposit = (await tx.execute<{ valid: boolean }>(sql`
      SELECT EXISTS(
        SELECT 1
        FROM fiat_deposit_intents intent
        JOIN ledger_transactions ledger
          ON ledger.id = intent.completed_ledger_id
        WHERE intent.id = ${input.depositIntentId}::uuid
          AND intent.user_id = ${input.userId}
          AND intent.provider_payment_id = ${input.providerPaymentId}
          AND intent.status = 'completed'
          AND intent.completed_ledger_id = ${input.ledgerId}::uuid
          AND intent.credited_amount_cents = ${input.amountCents}
          AND ledger.user_id = ${input.userId}
          AND ledger.type = 'deposit'
          AND ledger.status = 'completed'
          AND ledger.external_tx_id = ${input.providerPaymentId}
      ) AS valid
    `)).rows[0]?.valid;
    if (!creditedDeposit) {
      throw new Error("The credited Fiat deposit could not be verified.");
    }
    const account = (await tx.execute<{
      affiliate_bonus_expires_at: string | null;
      affiliate_code: string | null;
      affiliate_code_active: boolean;
      affiliate_code_expires_at: string | null;
      role: string;
    }>(sql`
      SELECT role::text, affiliate_code, affiliate_code_active,
             affiliate_code_expires_at::text, affiliate_bonus_expires_at::text
      FROM "user"
      WHERE id = ${input.userId}
      FOR UPDATE
    `)).rows[0];
    if (!account) throw new Error("The player account no longer exists.");

    const excludedRole = ["support", "admin", "creator"].includes(account.role);
    const affiliateActive =
      !excludedRole &&
      Boolean(account.affiliate_code) &&
      account.affiliate_code_active &&
      account.affiliate_code_expires_at != null &&
      new Date(account.affiliate_code_expires_at).getTime() > Date.now();
    const affiliateOwner = affiliateActive
      ? (await tx.execute<{ user_id: string }>(sql`
          SELECT account.user_id
          FROM affiliate_codes code
          JOIN affiliate_accounts account ON account.user_id = code.user_id
          WHERE UPPER(code.code) = UPPER(${account.affiliate_code})
          LIMIT 1
        `)).rows[0]
      : undefined;
    const validAffiliate =
      affiliateOwner && affiliateOwner.user_id !== input.userId
        ? affiliateOwner
        : undefined;

    if (validAffiliate) {
      const depositCount = Number(
        (await tx.execute<{ count: number }>(sql`
          SELECT COUNT(*)::int AS count
          FROM ledger_transactions
          WHERE user_id = ${input.userId}
            AND type = 'deposit'
            AND status = 'completed'
        `)).rows[0]?.count ?? 0,
      );
      const existingUsage = (await tx.execute<{ exists: boolean }>(sql`
        SELECT EXISTS(
          SELECT 1 FROM affiliate_code_usages
          WHERE affiliate_user_id = ${validAffiliate.user_id}
            AND referred_user_id = ${input.userId}
            AND usage_type = 'deposit'
        ) AS exists
      `)).rows[0]?.exists;
      if (depositCount === 1 && !existingUsage) {
        await tx.execute(sql`
          INSERT INTO affiliate_code_usages (
            id, affiliate_user_id, code, referred_user_id,
            deposit_amount_usd, referrer_cut_usd, user_bonus_usd,
            status, usage_type, wager_amount_usd, game_session_id,
            leaderboard_eligible, created_at, updated_at
          ) VALUES (
            ${crypto.randomUUID()}::uuid, ${validAffiliate.user_id},
            ${account.affiliate_code}, ${input.userId},
            ${(input.amountCents / 100).toFixed(2)}::numeric, 0, 0,
            'completed', 'deposit', 0, NULL, TRUE, NOW(), NOW()
          )
        `);
      }
    }

    let affiliateBonusCents = 0;
    const bonusWindowActive =
      validAffiliate &&
      account.affiliate_bonus_expires_at != null &&
      new Date(account.affiliate_bonus_expires_at).getTime() > Date.now();
    if (bonusWindowActive) {
      const existingBonus = (await tx.execute<{ id: string }>(sql`
        SELECT id::text
        FROM ledger_transactions
        WHERE type = 'deposit_bonus'
          AND metadata->>'whop_payment_id' = ${input.providerPaymentId}
        LIMIT 1
      `)).rows[0];
      if (!existingBonus) {
        const config = await tx.execute<{ key: string; value: unknown }>(sql`
          SELECT key, value FROM site_config
          WHERE key IN ('deposit_bonus_period_hours', 'deposit_bonus_cap_per_period_usd')
        `);
        const values = new Map(config.rows.map((row) => [row.key, row.value]));
        const periodHours = positiveConfigNumber(
          values.get("deposit_bonus_period_hours"),
          DEFAULT_DEPOSIT_BONUS_PERIOD_HOURS,
        );
        const capCents = Math.round(
          nonnegativeConfigNumber(
            values.get("deposit_bonus_cap_per_period_usd"),
            DEFAULT_DEPOSIT_BONUS_CAP_CENTS / 100,
          ) * 100,
        );
        const usedCents = Math.round(
          Number(
            (await tx.execute<{ total: string }>(sql`
              SELECT COALESCE(SUM(amount), 0)::text AS total
              FROM ledger_transactions
              WHERE user_id = ${input.userId}
                AND type = 'deposit_bonus'
                AND created_at >= NOW() - (${periodHours} * INTERVAL '1 hour')
            `)).rows[0]?.total ?? "0",
          ) * 100,
        );
        affiliateBonusCents = Math.min(
          Math.round((input.amountCents * DEPOSIT_BONUS_RATE_BPS) / 10_000),
          Math.max(0, capCents - usedCents),
        );
        if (affiliateBonusCents > 0) {
          const balance = (await tx.execute<{
            available_balance: string;
          }>(sql`
            SELECT available_balance::text
            FROM balances WHERE user_id = ${input.userId}
            FOR UPDATE
          `)).rows[0];
          if (!balance) throw new Error("The player balance could not be loaded.");
          const bonusLedgerId = crypto.randomUUID();
          const balanceAfter = (
            Number(balance.available_balance) +
            affiliateBonusCents / 100
          ).toFixed(2);
          const bonusAmount = (affiliateBonusCents / 100).toFixed(2);
          await tx.execute(sql`
            INSERT INTO ledger_transactions (
              id, user_id, type, amount, balance_before, balance_after,
              description, metadata, status, created_at, updated_at
            ) VALUES (
              ${bonusLedgerId}::uuid, ${input.userId}, 'deposit_bonus',
              ${bonusAmount}::numeric, ${balance.available_balance}::numeric,
              ${balanceAfter}::numeric,
              ${`Affiliate deposit bonus (5% of $${(input.amountCents / 100).toFixed(2)})`},
              ${JSON.stringify({
                affiliate_code: account.affiliate_code,
                deposit_usd: input.amountCents / 100,
                referrer_user_id: validAffiliate.user_id,
                whop_payment_id: input.providerPaymentId,
              })}::jsonb,
              'completed', NOW(), NOW()
            )
          `);
          await tx.execute(sql`
            UPDATE balances
            SET available_balance = ${balanceAfter}::numeric,
                last_transaction_id = ${bonusLedgerId}::uuid,
                version = version + 1, updated_at = NOW()
            WHERE user_id = ${input.userId}
          `);
        }
      }
    }

    for (const [index, fee] of fees.entries()) {
      const feeKey =
        typeof (fee as PaymentListFeesResponse & { id?: string }).id === "string"
          ? (fee as PaymentListFeesResponse & { id: string }).id
          : `${fee.type ?? "fee"}-${index}`;
      await tx.execute(sql`
        INSERT INTO payment_provider_fees (
          id, deposit_intent_id, provider_payment_id, fee_key,
          fee_type, fee_name, amount_cents, currency, raw_payload, created_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid, ${input.depositIntentId}::uuid,
          ${input.providerPaymentId}, ${feeKey}, ${fee.type ?? "unknown"},
          ${fee.name ?? fee.type ?? "Unknown fee"},
          ${Math.round(fee.amount * 100)}, ${fee.currency.toUpperCase()},
          ${JSON.stringify(fee)}::jsonb, NOW()
        )
        ON CONFLICT (deposit_intent_id, fee_key) DO UPDATE SET
          amount_cents = EXCLUDED.amount_cents,
          currency = EXCLUDED.currency,
          raw_payload = EXCLUDED.raw_payload
      `);
    }

    await tx.execute(sql`
      INSERT INTO notifications (
        id, user_id, category, type, payload, dedupe_key, created_at
      ) VALUES (
        ${crypto.randomUUID()}::uuid, ${input.userId}, 'transaction',
        'deposit_completed',
        ${JSON.stringify({
          amount_usd: (input.amountCents / 100).toFixed(2),
          asset_id: "FIAT",
          bonus_applied:
            affiliateBonusCents > 0
              ? (affiliateBonusCents / 100).toFixed(2)
              : null,
          method: "whop",
        })}::jsonb,
        ${`deposit_completed:${input.providerPaymentId}`}, NOW()
      )
      ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    `);

    return { affiliateBonusCents };
  });
}
