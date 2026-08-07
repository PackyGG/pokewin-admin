"use server";

import crypto from "crypto";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import {
  createAdminAuditEvent,
  createAdminAuditEventDurable,
} from "@/lib/admin-audit";
import { actionErrorMessage } from "@/lib/antifraud/action-error-message";
import { getPrimaryDrizzleDb, type MainDrizzleDb } from "@/lib/db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import {
  MAX_REFUNDS_PER_BATCH,
  resolveRefundSelection,
} from "@/lib/queries/whop-refunds";
import { require2FA } from "@/lib/require-2fa";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { safeWhopError, whopAdminClient } from "@/lib/whop-admin";
import {
  fail,
  ok,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";

type Selection =
  | { mode: "all"; ids?: never }
  | { mode: "users"; ids: string[] }
  | { mode: "payments"; ids: string[] };

const TOO_FEW = "Select at least one payment or user.";
const TOO_MANY = `Select at most ${MAX_REFUNDS_PER_BATCH} records.`;

const selectionIdsSchema = z
  .array(z.string().trim().min(1, TOO_FEW))
  .min(1, TOO_FEW)
  .max(MAX_REFUNDS_PER_BATCH, TOO_MANY);

/**
 * Hard allowlist of selection modes. Without it an unrecognised `mode` fell
 * through `queryCandidates` to the unfiltered "everything flagged" query —
 * i.e. a refund + ban + balance/inventory confiscation of up to
 * MAX_REFUNDS_PER_BATCH accounts from a single malformed call.
 */
const selectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("users"), ids: selectionIdsSchema }),
  z.object({ mode: z.literal("payments"), ids: selectionIdsSchema }),
]);

// Key order mirrors the previous hand-rolled check order, so the first
// reported issue stays the message operators already know.
const createRefundBatchSchema = z.object({
  confirmation: z.literal("REFUND", "Type REFUND exactly to confirm."),
  reason: z
    .string()
    .trim()
    .min(4, "Enter a refund reason from 4 to 500 characters.")
    .max(500, "Enter a refund reason from 4 to 500 characters."),
  // Not trimmed — the raw value is what require2FA verifies.
  credential: z.string().min(1, "Two-factor verification is required."),
  selection: selectionSchema,
});

export type RefundBatchProgress = {
  batchId: string;
  pending: number;
  processing: number;
  succeeded: number;
  alreadyRefunded: number;
  notRefundable: number;
  failed: number;
  unknown: number;
  done: boolean;
  recoveryFailedAccounts?: number;
  recoveryAuditFailures?: number;
};

export type RefundRecoveryResult = {
  batchId: string;
  attemptedAccounts: number;
  accounts: number;
  failedAccounts: number;
  auditFailures: number;
  complete: boolean;
  newlyBanned: number;
  alreadyBanned: number;
  recoveredBalanceUsd: number;
  recoveredInventoryUsd: number;
  recoveredVoucherUsd: number;
  recoveredTotalUsd: number;
  remainingUnrecoveredUsd: number;
};

type RefundRecoveryTarget = {
  userId: string;
  depositIntentIds: string[];
};

type UserRecoveryResult = {
  userId: string;
  newlyBanned: boolean;
  refundedCreditUsd: number;
  recoveredBalanceUsd: number;
  recoveredInventoryUsd: number;
  recoveredVoucherUsd: number;
  recoveredTotalUsd: number;
  remainingUnrecoveredUsd: number;
};

const REFUND_RECOVERY_REASON =
  "Whop payment refunded after fraud / KYC review; recovered remaining attributable on-site value";

function moneyNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100);
}

function dollars(valueInCents: number): number {
  return Number((valueInCents / 100).toFixed(2));
}

function takeWholeAssets<T extends { value: unknown }>(
  rows: T[],
  availableCents: number,
): { selected: T[]; valueCents: number } {
  const selected: T[] = [];
  let valueCents = 0;
  for (const row of rows) {
    const rowCents = cents(moneyNumber(row.value));
    if (rowCents <= 0 || valueCents + rowCents > availableCents) continue;
    selected.push(row);
    valueCents += rowCents;
  }
  return { selected, valueCents };
}

async function loadRefundRecoveryTargets(
  batchId: string,
): Promise<RefundRecoveryTarget[]> {
  const rows = (
    await adminDrizzle.execute<{
      user_id: string;
      deposit_intent_ids: string[];
    }>(sql`
      WITH target_users AS (
        SELECT DISTINCT user_id
        FROM admin_whop_refund_items
        WHERE batch_id = ${batchId}::uuid
          AND status IN ('succeeded', 'already_refunded')
      )
      SELECT
        item.user_id,
        array_agg(DISTINCT item.deposit_intent_id::text)
          AS deposit_intent_ids
      FROM admin_whop_refund_items item
      JOIN target_users target ON target.user_id = item.user_id
      WHERE item.status IN ('succeeded', 'already_refunded')
      GROUP BY item.user_id
      ORDER BY item.user_id
    `)
  ).rows;
  return rows.map((row) => ({
    userId: row.user_id,
    depositIntentIds: row.deposit_intent_ids,
  }));
}

async function loadAllRefundRecoveryTargets(): Promise<RefundRecoveryTarget[]> {
  const rows = (
    await adminDrizzle.execute<{
      user_id: string;
      deposit_intent_ids: string[];
    }>(sql`
      SELECT
        user_id,
        array_agg(DISTINCT deposit_intent_id::text) AS deposit_intent_ids
      FROM admin_whop_refund_items
      WHERE status IN ('succeeded', 'already_refunded')
      GROUP BY user_id
      ORDER BY user_id
    `)
  ).rows;
  return rows.map((row) => ({
    userId: row.user_id,
    depositIntentIds: row.deposit_intent_ids,
  }));
}

async function recoverRefundedUser(
  db: MainDrizzleDb,
  target: RefundRecoveryTarget,
  batchId: string,
  adminUserId: string,
): Promise<UserRecoveryResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"whop-refund-recovery:" + target.userId}, 0)
      )
    `);

    const user = (
      await tx.execute<{ is_banned: boolean }>(sql`
        SELECT is_banned
        FROM "user"
        WHERE id = ${target.userId}
        FOR UPDATE
      `)
    ).rows[0];
    if (!user) throw new Error("Refunded Packy account no longer exists.");

    const refunded = (
      await tx.execute<{ credited_usd: string }>(sql`
        SELECT COALESCE(SUM(credited_amount_cents), 0) / 100.0 AS credited_usd
        FROM fiat_deposit_intents
        WHERE id = ANY(
          ${pgArrayParam(target.depositIntentIds)}::uuid[]
        )
          AND user_id = ${target.userId}
      `)
    ).rows[0];
    const refundedCreditCents = cents(moneyNumber(refunded?.credited_usd));

    const prior = (
      await tx.execute<{ recovered_usd: string }>(sql`
        SELECT COALESCE(
          SUM(
            CASE
              WHEN COALESCE(metadata->>'recovered_value_usd', '') ~
                '^[0-9]+([.][0-9]+)?$'
              THEN (metadata->>'recovered_value_usd')::numeric
              ELSE 0
            END
          ),
          0
        )::text AS recovered_usd
        FROM ledger_transactions
        WHERE user_id = ${target.userId}
          AND type::text = 'admin_balance_adjustment'
          AND metadata->>'kind' = 'whop_refund_recovery'
          AND status::text = 'completed'
      `)
    ).rows[0];
    const priorRecoveredCents = cents(moneyNumber(prior?.recovered_usd));
    let remainingCents = Math.max(0, refundedCreditCents - priorRecoveredCents);

    const updatedUsers = (
      await tx.execute<{ id: string }>(sql`
      UPDATE "user"
      SET
        is_banned = TRUE,
        banned_reason = CASE
          WHEN is_banned THEN banned_reason
          ELSE ${REFUND_RECOVERY_REASON}
        END,
        banned_at = COALESCE(banned_at, NOW()),
        updated_at = NOW()
      WHERE id = ${target.userId}
      RETURNING id::text
    `)
    ).rows;
    if (updatedUsers.length !== 1) {
      throw new Error("Refunded Packy account could not be banned.");
    }
    await tx.execute(sql`
      DELETE FROM session
      WHERE "userId" = ${target.userId}
    `);

    const balance = (
      await tx.execute<{
        available_balance: string;
        locked_balance: string;
      }>(sql`
        SELECT
          available_balance::text,
          locked_balance::text
        FROM balances
        WHERE user_id = ${target.userId}
        FOR UPDATE
      `)
    ).rows[0];
    const availableBeforeCents = cents(moneyNumber(balance?.available_balance));
    const lockedBeforeCents = cents(moneyNumber(balance?.locked_balance));
    const availableTakeCents = Math.min(remainingCents, availableBeforeCents);
    remainingCents -= availableTakeCents;
    const lockedTakeCents = Math.min(remainingCents, lockedBeforeCents);
    remainingCents -= lockedTakeCents;
    const balanceTakeCents = availableTakeCents + lockedTakeCents;

    if (balance && balanceTakeCents > 0) {
      const updatedBalances = (
        await tx.execute<{ user_id: string }>(sql`
        UPDATE balances
        SET
          available_balance =
            available_balance - ${dollars(availableTakeCents)}::numeric,
          locked_balance =
            locked_balance - ${dollars(lockedTakeCents)}::numeric,
          version = version + 1,
          updated_at = NOW()
        WHERE user_id = ${target.userId}
        RETURNING user_id::text
      `)
      ).rows;
      if (updatedBalances.length !== 1) {
        throw new Error("Refunded account balance changed during recovery.");
      }
    }

    if (availableTakeCents > 0) {
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${target.userId},
          'admin_balance_adjustment',
          -${dollars(availableTakeCents)}::numeric,
          ${dollars(availableBeforeCents)}::numeric,
          ${dollars(availableBeforeCents - availableTakeCents)}::numeric,
          ${`Admin adjustment: ${REFUND_RECOVERY_REASON}`},
          ${JSON.stringify({
            kind: "whop_refund_recovery",
            adjustment_category: "fraud_abuse",
            batch_id: batchId,
            initiated_by_admin_user_id: adminUserId,
            recovered_value_usd: dollars(availableTakeCents),
            recovered_available_usd: dollars(availableTakeCents),
            recovered_locked_usd: 0,
          })}::jsonb,
          'completed',
          NOW(),
          NOW()
        )
      `);
    }

    if (lockedTakeCents > 0) {
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${target.userId},
          'admin_balance_adjustment',
          -${dollars(lockedTakeCents)}::numeric,
          ${dollars(lockedBeforeCents)}::numeric,
          ${dollars(lockedBeforeCents - lockedTakeCents)}::numeric,
          ${`Locked balance adjustment: ${REFUND_RECOVERY_REASON}`},
          ${JSON.stringify({
            kind: "whop_refund_recovery",
            adjustment_category: "remove_locked_balance",
            balance_target: "locked",
            batch_id: batchId,
            initiated_by_admin_user_id: adminUserId,
            recovered_value_usd: dollars(lockedTakeCents),
            recovered_available_usd: 0,
            recovered_locked_usd: dollars(lockedTakeCents),
          })}::jsonb,
          'completed',
          NOW(),
          NOW()
        )
      `);
    }

    const vouchers = (
      await tx.execute<{ id: string; value: string }>(sql`
        SELECT id::text, value::text
        FROM vouchers
        WHERE user_id = ${target.userId}
          AND claimed_at IS NULL
        ORDER BY value ASC, created_at ASC, id ASC
        FOR UPDATE
      `)
    ).rows;
    const voucherSelection = takeWholeAssets(vouchers, remainingCents);
    remainingCents -= voucherSelection.valueCents;
    if (voucherSelection.selected.length > 0) {
      const voucherIds = voucherSelection.selected.map((row) => row.id);
      const deletedVouchers = (
        await tx.execute<{ id: string }>(sql`
        DELETE FROM vouchers
        WHERE id = ANY(${pgArrayParam(voucherIds)}::uuid[])
          AND user_id = ${target.userId}
          AND claimed_at IS NULL
        RETURNING id::text
      `)
      ).rows;
      if (deletedVouchers.length !== voucherIds.length) {
        throw new Error("Refunded account vouchers changed during recovery.");
      }
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${target.userId},
          'admin_balance_adjustment',
          -${dollars(voucherSelection.valueCents)}::numeric,
          ${dollars(availableBeforeCents - availableTakeCents)}::numeric,
          ${dollars(availableBeforeCents - availableTakeCents)}::numeric,
          ${`Voucher value recovered: ${REFUND_RECOVERY_REASON}`},
          ${JSON.stringify({
            kind: "whop_refund_recovery",
            asset_kind: "voucher",
            batch_id: batchId,
            initiated_by_admin_user_id: adminUserId,
            recovered_value_usd: dollars(voucherSelection.valueCents),
            voucher_ids: voucherIds,
          })}::jsonb,
          'completed',
          NOW(),
          NOW()
        )
      `);
    }

    const inventory = (
      await tx.execute<{
        id: string;
        value: string;
      }>(sql`
        SELECT
          ui.id::text,
          ui.value_at_obtained::text AS value
        FROM user_inventory ui
        WHERE ui.user_id = ${target.userId}
          AND ui.sold_at IS NULL
          AND ui.exchanged_at IS NULL
          AND ui.withdrawal_locked_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM card_withdrawal_requests cwr
            WHERE cwr.user_id = ${target.userId}
              AND cwr.status::text IN ('pending', 'processing', 'shipped')
              AND cwr.inventory_item_ids @> ARRAY[ui.id]
          )
        ORDER BY ui.value_at_obtained ASC, ui.created_at ASC, ui.id ASC
        FOR UPDATE OF ui
      `)
    ).rows;
    const inventorySelection = takeWholeAssets(inventory, remainingCents);
    remainingCents -= inventorySelection.valueCents;
    if (inventorySelection.selected.length > 0) {
      const inventoryIds = inventorySelection.selected.map((row) => row.id);
      await tx.execute(sql`
        DELETE FROM provably_fair_results
        WHERE inventory_item_id = ANY(
          ${pgArrayParam(inventoryIds)}::uuid[]
        )
      `);
      const updatedInventory = (
        await tx.execute<{ id: string }>(sql`
        UPDATE user_inventory
        SET sold_at = NOW(), updated_at = NOW()
        WHERE id = ANY(${pgArrayParam(inventoryIds)}::uuid[])
          AND user_id = ${target.userId}
          AND sold_at IS NULL
          AND exchanged_at IS NULL
        RETURNING id::text
      `)
      ).rows;
      if (updatedInventory.length !== inventoryIds.length) {
        throw new Error("Refunded account inventory changed during recovery.");
      }
      await tx.execute(sql`
        INSERT INTO ledger_transactions (
          id, user_id, type, amount, balance_before, balance_after,
          description, metadata, status, created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${target.userId},
          'admin_balance_adjustment',
          -${dollars(inventorySelection.valueCents)}::numeric,
          ${dollars(availableBeforeCents - availableTakeCents)}::numeric,
          ${dollars(availableBeforeCents - availableTakeCents)}::numeric,
          ${`Inventory value recovered: ${REFUND_RECOVERY_REASON}`},
          ${JSON.stringify({
            kind: "whop_refund_recovery",
            asset_kind: "inventory",
            batch_id: batchId,
            initiated_by_admin_user_id: adminUserId,
            recovered_value_usd: dollars(inventorySelection.valueCents),
            inventory_item_ids: inventoryIds,
          })}::jsonb,
          'completed',
          NOW(),
          NOW()
        )
      `);
    }

    const recoveredTotalCents =
      balanceTakeCents +
      voucherSelection.valueCents +
      inventorySelection.valueCents;
    return {
      userId: target.userId,
      newlyBanned: !user.is_banned,
      refundedCreditUsd: dollars(refundedCreditCents),
      recoveredBalanceUsd: dollars(balanceTakeCents),
      recoveredInventoryUsd: dollars(inventorySelection.valueCents),
      recoveredVoucherUsd: dollars(voucherSelection.valueCents),
      recoveredTotalUsd: dollars(recoveredTotalCents),
      remainingUnrecoveredUsd: dollars(remainingCents),
    };
  });
}

async function recoverRefundedAccountsForBatch(
  batchId: string,
  adminUserId: string,
  targetsOverride?: RefundRecoveryTarget[],
): Promise<RefundRecoveryResult> {
  const targets = targetsOverride ?? (await loadRefundRecoveryTargets(batchId));
  const db = await getPrimaryDrizzleDb();
  const recovered: UserRecoveryResult[] = [];
  const failedUserIds: string[] = [];
  let auditFailures = 0;
  for (const target of targets) {
    try {
      const row = await recoverRefundedUser(db, target, batchId, adminUserId);
      recovered.push(row);
      // The ban / balance adjustment / voucher-inventory deletion above has
      // already committed on MAIN — this audit write must not be allowed to
      // silently vanish, so it goes through the durable retry+fallback path
      // instead of a bare try/catch-and-count.
      const auditOutcome = await createAdminAuditEventDurable({
        adminUserId,
        eventType: "whop_refund_account_recovered",
        targetUserId: row.userId,
        metadata: {
          batch_id: batchId,
          newly_banned: row.newlyBanned,
          refunded_credit_usd: row.refundedCreditUsd,
          recovered_balance_usd: row.recoveredBalanceUsd,
          recovered_inventory_usd: row.recoveredInventoryUsd,
          recovered_voucher_usd: row.recoveredVoucherUsd,
          recovered_total_usd: row.recoveredTotalUsd,
          remaining_unrecovered_usd: row.remainingUnrecoveredUsd,
        },
      });
      if (auditOutcome.status === "lost") auditFailures += 1;
    } catch {
      failedUserIds.push(target.userId);
      const auditOutcome = await createAdminAuditEventDurable({
        adminUserId,
        eventType: "whop_refund_account_recovery_failed",
        targetUserId: target.userId,
        metadata: {
          batch_id: batchId,
          error_code: "recovery_transaction_failed",
        },
      });
      if (auditOutcome.status === "lost") auditFailures += 1;
    }
  }

  const result: RefundRecoveryResult = {
    batchId,
    attemptedAccounts: targets.length,
    accounts: recovered.length,
    failedAccounts: failedUserIds.length,
    auditFailures,
    complete: failedUserIds.length === 0,
    newlyBanned: recovered.filter((row) => row.newlyBanned).length,
    alreadyBanned: recovered.filter((row) => !row.newlyBanned).length,
    recoveredBalanceUsd: dollars(
      recovered.reduce((sum, row) => sum + cents(row.recoveredBalanceUsd), 0),
    ),
    recoveredInventoryUsd: dollars(
      recovered.reduce((sum, row) => sum + cents(row.recoveredInventoryUsd), 0),
    ),
    recoveredVoucherUsd: dollars(
      recovered.reduce((sum, row) => sum + cents(row.recoveredVoucherUsd), 0),
    ),
    recoveredTotalUsd: dollars(
      recovered.reduce((sum, row) => sum + cents(row.recoveredTotalUsd), 0),
    ),
    remainingUnrecoveredUsd: dollars(
      recovered.reduce(
        (sum, row) => sum + cents(row.remainingUnrecoveredUsd),
        0,
      ),
    ),
  };

  const summaryOutcome = await createAdminAuditEventDurable({
    adminUserId,
    eventType: "whop_refund_accounts_recovered",
    metadata: {
      ...result,
      failed_user_ids: failedUserIds,
      users: recovered.map((row) => ({
        user_id: row.userId,
        refunded_credit_usd: row.refundedCreditUsd,
        recovered_usd: row.recoveredTotalUsd,
        remaining_unrecovered_usd: row.remainingUnrecoveredUsd,
      })),
    },
  });
  if (summaryOutcome.status === "lost") result.auditFailures += 1;
  return result;
}

function validateSelection(selection: Selection): Selection {
  if (selection.mode === "all") return selection;
  const ids = [
    ...new Set(selection.ids.map((id) => id.trim()).filter(Boolean)),
  ];
  if (ids.length === 0) throw new Error("Select at least one payment or user.");
  if (ids.length > MAX_REFUNDS_PER_BATCH) {
    throw new Error(`Select at most ${MAX_REFUNDS_PER_BATCH} records.`);
  }
  return { mode: selection.mode, ids } as Selection;
}

const REFUND_FALLBACK =
  "The refund operation could not be completed. No automatic retry was made.";

export async function createRefundBatch(input: {
  selection: Selection;
  credential: string;
  confirmation: string;
  reason: string;
}): Promise<ServerActionResult<RefundBatchProgress>> {
  const session = await requireAntifraudManager(
    "Only owners and admins can execute refunds.",
  );
  try {
    const parsed = createRefundBatchSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0].message);
    const reason = parsed.data.reason;
    await require2FA(session.userId, parsed.data.credential);

    // De-dupes the (already shape-validated) ids exactly as before.
    const selection = validateSelection(parsed.data.selection as Selection);
    const candidates = await resolveRefundSelection(selection);
    if (candidates.length === 0) {
      throw new Error(
        "No new refundable deposits remain in that eligible selection.",
      );
    }

    const batch = await adminDrizzle.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO admin_whop_refund_batches (
        requested_by, selection_mode, reason, status, requested_count
      )
      VALUES (
        ${session.userId}::uuid,
        ${selection.mode},
        ${reason},
        'pending',
        ${candidates.length}
      )
      RETURNING id::text
    `);
      const batchId = inserted.rows[0]?.id;
      if (!batchId) throw new Error("Could not create the refund batch.");

      const values = candidates.map(
        (candidate) => sql`(
        ${batchId}::uuid,
        ${candidate.userId},
        ${candidate.depositIntentId}::uuid,
        ${candidate.providerPaymentId},
        ${candidate.currency.toLowerCase()},
        ${candidate.amountCents}
      )`,
      );
      const items = await tx.execute(sql`
      INSERT INTO admin_whop_refund_items (
        batch_id,
        user_id,
        deposit_intent_id,
        provider_payment_id,
        currency,
        original_amount_cents
      )
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (provider_payment_id) DO NOTHING
      RETURNING id
    `);
      if (items.rows.length === 0) {
        throw new Error("Those deposits are already in refund batches.");
      }
      await tx.execute(sql`
      UPDATE admin_whop_refund_batches
      SET requested_count = ${items.rows.length}, updated_at = now()
      WHERE id = ${batchId}::uuid
    `);
      return { id: batchId, count: items.rows.length };
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "whop_refund_batch_created",
      metadata: {
        batchId: batch.id,
        selectionMode: selection.mode,
        paymentCount: batch.count,
        reason,
      },
    });
    revalidatePath("/antifraud/refunds");
    return ok(await getRefundBatchProgress(batch.id));
  } catch (error) {
    return fail(actionErrorMessage(error, REFUND_FALLBACK));
  }
}

async function finalizeBatch(
  batchId: string,
  adminUserId: string,
): Promise<RefundRecoveryResult | null> {
  const result = await adminDrizzle.execute<{
    status: string;
    requested_count: number;
  }>(sql`
    WITH counts AS (
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('pending', 'processing')
        )::integer AS unfinished,
        COUNT(*) FILTER (
          WHERE status NOT IN ('succeeded', 'already_refunded')
        )::integer AS issues
      FROM admin_whop_refund_items
      WHERE batch_id = ${batchId}::uuid
    )
    UPDATE admin_whop_refund_batches b
    SET
      status = CASE
        WHEN counts.issues = 0 THEN 'completed'
        ELSE 'completed_with_issues'
      END,
      completed_at = now(),
      updated_at = now()
    FROM counts
    WHERE b.id = ${batchId}::uuid
      AND b.status IN ('pending', 'processing')
      AND counts.unfinished = 0
    RETURNING b.status, b.requested_count
  `);
  const completed = result.rows[0];
  if (completed) {
    const recovery = await recoverRefundedAccountsForBatch(
      batchId,
      adminUserId,
    );
    const completedOutcome = await createAdminAuditEventDurable({
      adminUserId,
      eventType: "whop_refund_batch_completed",
      metadata: {
        batchId,
        status: completed.status,
        paymentCount: completed.requested_count,
        recoveryFailedAccounts: recovery.failedAccounts,
      },
    });
    if (completedOutcome.status === "lost") recovery.auditFailures += 1;
    return recovery;
  }
  return null;
}

export async function processNextRefund(
  batchId: string,
): Promise<ServerActionResult<RefundBatchProgress>> {
  const session = await requireAntifraudManager(
    "Only owners and admins can execute refunds.",
  );
  try {
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("Invalid batch.");

    const claimed = await adminDrizzle.execute<{
      id: string;
      provider_payment_id: string;
    }>(sql`
    WITH next_item AS (
      SELECT id
      FROM admin_whop_refund_items
      WHERE batch_id = ${batchId}::uuid
        AND (
          status = 'pending'
          OR (status = 'processing' AND leased_until < now())
        )
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE admin_whop_refund_items item
    SET
      status = 'processing',
      attempt_count = attempt_count + 1,
      lease_token = gen_random_uuid(),
      leased_until = now() + interval '45 seconds',
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    FROM next_item
    WHERE item.id = next_item.id
    RETURNING item.id::text, item.provider_payment_id
    `);
    const item = claimed.rows[0];
    if (!item) {
      const finalizedRecovery = await finalizeBatch(batchId, session.userId);
      const recovery =
        finalizedRecovery ??
        (await recoverRefundedAccountsForBatch(batchId, session.userId));
      const progress = await getRefundBatchProgress(batchId);
      return ok({
        ...progress,
        recoveryFailedAccounts: recovery.failedAccounts,
        recoveryAuditFailures: recovery.auditFailures,
      });
    }

    await adminDrizzle.execute(sql`
    UPDATE admin_whop_refund_batches
    SET status = 'processing', updated_at = now()
    WHERE id = ${batchId}::uuid AND status = 'pending'
  `);

    let refundRequested = false;
    try {
      const client = whopAdminClient();
      const payment = await client.payments.retrieve(item.provider_payment_id);
      if (!payment.refundable) {
        const fullyRefunded =
          payment.substatus === "refunded" ||
          (payment.total !== null &&
            payment.refunded_amount !== null &&
            payment.refunded_amount >= payment.total);
        await adminDrizzle.execute(sql`
        UPDATE admin_whop_refund_items
        SET
          status = ${fullyRefunded ? "already_refunded" : "not_refundable"},
          provider_status = ${payment.status},
          provider_substatus = ${payment.substatus},
          refunded_amount = ${payment.refunded_amount},
          completed_at = now(),
          lease_token = NULL,
          leased_until = NULL,
          updated_at = now()
        WHERE id = ${item.id}::uuid
          AND status = 'processing'
      `);
      } else {
        // Omit partial_amount intentionally: Whop defines this as a full refund.
        refundRequested = true;
        const refunded = await client.payments.refund(item.provider_payment_id);
        await adminDrizzle.execute(sql`
        UPDATE admin_whop_refund_items
        SET
          status = 'succeeded',
          provider_status = ${refunded.status},
          provider_substatus = ${refunded.substatus},
          refunded_amount = ${refunded.refunded_amount},
          completed_at = now(),
          lease_token = NULL,
          leased_until = NULL,
          updated_at = now()
        WHERE id = ${item.id}::uuid
          AND status = 'processing'
      `);
      }
    } catch (error) {
      const safe = safeWhopError(error);
      await adminDrizzle.execute(sql`
      UPDATE admin_whop_refund_items
      SET
        status = ${safe.outcomeUnknown || refundRequested ? "unknown" : "failed"},
        error_code = ${safe.code},
        error_message = ${safe.message},
        completed_at = now(),
        lease_token = NULL,
        leased_until = NULL,
        updated_at = now()
      WHERE id = ${item.id}::uuid
        AND status = 'processing'
    `);
    }

    const recovery = await finalizeBatch(batchId, session.userId);
    revalidatePath("/antifraud/refunds");
    const progress = await getRefundBatchProgress(batchId);
    return ok({
      ...progress,
      recoveryFailedAccounts: recovery?.failedAccounts,
      recoveryAuditFailures: recovery?.auditFailures,
    });
  } catch (error) {
    return fail(actionErrorMessage(error, REFUND_FALLBACK));
  }
}

export async function recoverRefundedBatch(input: {
  batchId: string;
  credential: string;
}): Promise<ServerActionResult<RefundRecoveryResult>> {
  const session = await requireAntifraudManager(
    "Only owners and admins can recover refunded accounts.",
  );
  try {
    if (!/^[0-9a-f-]{36}$/i.test(input.batchId)) {
      throw new Error("Invalid batch.");
    }
    await require2FA(session.userId, input.credential);
    const result = await recoverRefundedAccountsForBatch(
      input.batchId,
      session.userId,
    );
    revalidatePath("/antifraud/refunds");
    revalidatePath("/users");
    return ok(result);
  } catch (error) {
    return fail(actionErrorMessage(error, REFUND_FALLBACK));
  }
}

export async function recoverAllRefundedAccounts(input: {
  credential: string;
}): Promise<ServerActionResult<RefundRecoveryResult>> {
  const session = await requireAntifraudManager(
    "Only owners and admins can recover refunded accounts.",
  );
  try {
    await require2FA(session.userId, input.credential);
    const targets = await loadAllRefundRecoveryTargets();
    const result = await recoverRefundedAccountsForBatch(
      "all-successful-refunds",
      session.userId,
      targets,
    );
    revalidatePath("/antifraud/refunds");
    revalidatePath("/users");
    return ok(result);
  } catch (error) {
    return fail(actionErrorMessage(error, REFUND_FALLBACK));
  }
}

export async function getRefundBatchProgress(
  batchId: string,
): Promise<RefundBatchProgress> {
  await requireAntifraudManager(
    "Only owners and admins can view refund progress.",
  );
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("Invalid batch.");
  const result = await adminDrizzle.execute<{
    pending: number;
    processing: number;
    succeeded: number;
    already_refunded: number;
    not_refundable: number;
    failed: number;
    unknown: number;
  }>(sql`
    SELECT
      COUNT(i.id) FILTER (WHERE i.status = 'pending')::integer AS pending,
      COUNT(i.id) FILTER (WHERE i.status = 'processing')::integer AS processing,
      COUNT(i.id) FILTER (WHERE i.status = 'succeeded')::integer AS succeeded,
      COUNT(i.id) FILTER (WHERE i.status = 'already_refunded')::integer
        AS already_refunded,
      COUNT(i.id) FILTER (WHERE i.status = 'not_refundable')::integer
        AS not_refundable,
      COUNT(i.id) FILTER (WHERE i.status = 'failed')::integer AS failed,
      COUNT(i.id) FILTER (WHERE i.status = 'unknown')::integer AS unknown
    FROM admin_whop_refund_batches b
    LEFT JOIN admin_whop_refund_items i ON i.batch_id = b.id
    WHERE b.id = ${batchId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Refund batch not found.");
  const progress = {
    batchId,
    pending: Number(row.pending ?? 0),
    processing: Number(row.processing ?? 0),
    succeeded: Number(row.succeeded ?? 0),
    alreadyRefunded: Number(row.already_refunded ?? 0),
    notRefundable: Number(row.not_refundable ?? 0),
    failed: Number(row.failed ?? 0),
    unknown: Number(row.unknown ?? 0),
    done: false,
  };
  progress.done = progress.pending + progress.processing === 0;
  return progress;
}
