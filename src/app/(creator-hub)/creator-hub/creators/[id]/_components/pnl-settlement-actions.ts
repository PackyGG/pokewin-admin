"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { adjustBalance } from "@/app/(admin)/users/[id]/actions";
import { roundSettlementMoney } from "@/lib/creator-pnl-settlement-math";
import { creatorsApi } from "@/lib/backend-api/creators";
import { multiplierDealsApi } from "@/lib/backend-api/multiplier-deals";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { requireCapability } from "@/lib/require-capability";
import {
  computeCreatorPnlPreview,
  getAdminCreatorPnlDeal,
} from "@/lib/creator-pnl-settlement";

const CreditSchema = z.object({
  userId: z.string().trim().min(8).max(128),
  dealId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500),
  totpCode: z.string().trim().min(1).max(2048),
});

function safeCreditError(error: unknown) {
  const message = error instanceof Error ? error.message : "Balance credit failed.";
  if (/not authorized|2fa|two-factor|totp|limit|balance|refresh and retry|already reserved/i.test(message)) {
    return message;
  }
  return "Balance credit failed. The deal remains reserved; retry to reconcile it safely.";
}

function invalidate(userId: string) {
  revalidateTag("creator-deal");
  revalidateTag(`users-detail-${userId}`);
  revalidatePath(`/creator-hub/creators/${userId}`);
  revalidatePath(`/users/${userId}`);
}

export async function creditCreatorPnlShareAction(input: z.input<typeof CreditSchema>): Promise<
  | { success: true; ledgerTxId: string; amountUsd: number }
  | { success: false; error: string }
> {
  const session = await requireCreatorHubAccess("Not authorized to credit creator PnL shares.");
  const parsed = CreditSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid payout." };
  const data = parsed.data;

  const deal = await getAdminCreatorPnlDeal(data.userId, data.dealId);
  if (!deal) return { success: false, error: "PnL deal not found." };
  if (deal.creator_user_id !== data.userId) return { success: false, error: "PnL deal creator mismatch." };
  if (new Date(deal.frame_end_utc).getTime() > Date.now()) return { success: false, error: "The PnL frame has not ended." };

  const preview = deal.settlement_breakdown;
  if (!preview || deal.frame_site_pnl_usd == null || deal.creator_share_usd == null) {
    return { success: false, error: "Calculate and freeze the frame preview before crediting it." };
  }
  const payoutAmountUsd = roundSettlementMoney(Number(deal.creator_share_usd));
  if (!Number.isFinite(payoutAmountUsd) || payoutAmountUsd <= 0) {
    return { success: false, error: "This frame has no positive contractual payout." };
  }
  if (payoutAmountUsd > 1_000_000) {
    return { success: false, error: "The contractual payout exceeds the per-payment safety limit." };
  }
  if (deal.status === "settled" && deal.credit_ledger_id && deal.credited_amount_usd != null) {
    if (Number(deal.credited_amount_usd) !== payoutAmountUsd) {
      return { success: false, error: "The settled payout does not match the frozen contractual share." };
    }
    const [ledger] = await queryRows<Array<{
      id: string; amount: string; balance_before: string; balance_after: string; created_at: string;
    }>>(
      await getPrimaryDrizzleDb(),
      `SELECT id::text,amount::text,balance_before::text,balance_after::text,created_at::text
         FROM ledger_transactions
        WHERE id=$1::uuid AND external_tx_id=$2 AND user_id=$3
          AND type::text='admin_balance_adjustment' AND status='completed'
          AND amount::numeric=$4::numeric
          AND metadata->>'adjustment_category'='creator_pnl_share'
          AND metadata->>'creator_pnl_deal_id'=$5 LIMIT 1`,
      deal.credit_ledger_id, deal.credit_idempotency_key, data.userId,
      payoutAmountUsd, deal.id,
    );
    if (!ledger) {
      return { success: false, error: "The settled payout ledger does not match the frozen PnL contract." };
    }
    await adminDrizzle.transaction(async (tx) => {
      await queryRows(tx, `SELECT id FROM creator_pnl_deals WHERE id=$1::uuid FOR UPDATE`, deal.id);
      await queryRows(tx,
        `INSERT INTO admin_audit_events (admin_user_id,event_type,target_user_id,metadata)
         SELECT $1::uuid,'creator_pnl_share_credited',$2,$3::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM admin_audit_events
             WHERE event_type='creator_pnl_share_credited'
               AND metadata->>'dealId'=$4
          )`,
        deal.credited_by_admin_user_id, data.userId, JSON.stringify({
          dealId: deal.id,
          sourceApprovalRequestId: deal.source_approval_request_id,
          amountUsd: payoutAmountUsd,
          contractualAmountUsd: payoutAmountUsd,
          deviationUsd: 0,
          ledgerTxId: ledger.id,
          ledgerCreatedAt: ledger.created_at,
          balanceBeforeUsd: Number(ledger.balance_before),
          balanceAfterUsd: Number(ledger.balance_after),
          externalTxId: deal.credit_idempotency_key,
          settlementReason: deal.settlement_reason,
          frameStartAt: deal.frame_start_utc,
          frameEndAt: deal.frame_end_utc,
          positivePnlShareBps: deal.positive_pnl_share_bps,
          frameSitePnlUsd: preview.frame_site_pnl_usd,
          computationVersion: preview.computation_version,
          calculatedAt: preview.computed_at,
          fundingMode: deal.funding_mode,
          trigger: "manual_admin",
          surface: "creator_hub",
          immediatelyWithdrawable: true,
          repairedOnRetry: true,
        }), deal.id);
    });
    return { success: true, ledgerTxId: ledger.id, amountUsd: payoutAmountUsd };
  }
  if (!["calculated", "crediting"].includes(deal.status)) {
    return { success: false, error: `PnL deal cannot be credited from ${deal.status}.` };
  }
  if (deal.status === "crediting" && Number(deal.credited_amount_usd) !== payoutAmountUsd) {
    return { success: false, error: "A different payout is already reserved for this deal." };
  }
  const expectedMarker = `creator-pnl:${deal.id}`;
  if (deal.credit_idempotency_key !== expectedMarker) {
    return { success: false, error: "PnL deal has an invalid credit idempotency marker." };
  }
  const externalTxId = deal.credit_idempotency_key;
  let settlementReason = data.reason;
  let reservedByAdminUserId = session.userId;
  try {
    await adminDrizzle.transaction(async (tx) => {
      const rows = await queryRows<Array<{
        status: string; version: number; credited_amount_usd: string | null;
        settlement_reason: string | null; credited_by_admin_user_id: string | null;
      }>>(tx,
        `SELECT status, version, credited_amount_usd::text, settlement_reason,
                credited_by_admin_user_id::text
           FROM creator_pnl_deals
          WHERE id=$1::uuid AND creator_user_id=$2 FOR UPDATE`, deal.id, data.userId);
      const current = rows[0];
      if (!current) throw new Error("PnL deal not found.");
      if (current.status === "settled") {
        settlementReason = current.settlement_reason ?? data.reason;
        reservedByAdminUserId = current.credited_by_admin_user_id ?? session.userId;
        return;
      }
      if (current.status === "crediting") {
        if (Number(current.credited_amount_usd) !== payoutAmountUsd) throw new Error("A different payout is already reserved for this deal.");
        settlementReason = current.settlement_reason ?? data.reason;
        reservedByAdminUserId = current.credited_by_admin_user_id ?? session.userId;
        return;
      }
      if (current.version !== data.expectedVersion) throw new Error("PnL deal changed. Refresh and retry.");
      if (current.status !== "calculated") throw new Error(`PnL deal cannot be credited from ${current.status}.`);
      await queryRows(tx,
        `UPDATE creator_pnl_deals SET status='crediting', credited_amount_usd=$2::numeric,
          credited_by_admin_user_id=$3::uuid, settlement_reason=$4,
          credit_status='crediting', credit_attempted_at=now(), credit_error=NULL,
          version=version+1, updated_at=now()
          WHERE id=$1::uuid`, deal.id, payoutAmountUsd, session.userId, data.reason);
      await queryRows(tx,
        `INSERT INTO admin_audit_events (admin_user_id,event_type,target_user_id,metadata)
         VALUES ($1::uuid,'creator_pnl_share_credit_reserved',$2,$3::jsonb)`,
        session.userId, data.userId, JSON.stringify({
          dealId: deal.id,
          sourceApprovalRequestId: deal.source_approval_request_id,
          contractualAmountUsd: payoutAmountUsd,
          positivePnlShareBps: deal.positive_pnl_share_bps,
          frameSitePnlUsd: preview.frame_site_pnl_usd,
          frameStartAt: deal.frame_start_utc,
          frameEndAt: deal.frame_end_utc,
          computationVersion: preview.computation_version,
          settlementReason: data.reason,
          externalTxId,
          trigger: "manual_admin",
          surface: "creator_hub",
        }));
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Could not reserve the payout." };
  }

  let ledgerTxId: string | null = null;
  let recoveredAfterAmbiguousOutcome = false;
  try {
    const credit = await adjustBalance({
      userId: data.userId,
      amount: payoutAmountUsd,
      category: "creator_pnl_share",
      reason: `Creator PnL share — ${settlementReason}`,
      totpCode: data.totpCode,
      details: {
        creatorId: data.userId,
        creatorPnlDealId: deal.id,
        creatorPnlFrameStartUtc: deal.frame_start_utc,
        creatorPnlFrameEndUtc: deal.frame_end_utc,
        creatorPnlShareBps: deal.positive_pnl_share_bps,
        creatorPnlFrameSitePnlUsd: preview.frame_site_pnl_usd,
      },
    });
    if (!credit.success) throw new Error(credit.error);
    ledgerTxId = credit.ledgerTxId;
  } catch (error) {
    // An ambiguous transaction outcome is reconciled from the unique marker.
    let recovered: Array<{ id: string }>;
    try {
      recovered = await queryRows<Array<{ id: string }>>(
        await getPrimaryDrizzleDb(),
        `SELECT id::text FROM ledger_transactions WHERE external_tx_id=$1
        AND user_id=$2 AND type::text='admin_balance_adjustment' AND status='completed'
        AND amount::numeric=$3::numeric AND metadata->>'adjustment_category'='creator_pnl_share'
        AND metadata->>'creator_pnl_deal_id'=$4
        AND metadata->>'creator_pnl_frame_start_utc'=$5
        AND metadata->>'creator_pnl_frame_end_utc'=$6
        AND (metadata->>'creator_pnl_share_bps')::numeric=$7::numeric
        AND (metadata->>'creator_pnl_frame_site_pnl_usd')::numeric=$8::numeric LIMIT 1`,
        externalTxId, data.userId, payoutAmountUsd, deal.id, deal.frame_start_utc,
        deal.frame_end_utc, deal.positive_pnl_share_bps, preview.frame_site_pnl_usd);
    } catch {
      return { success: false, error: "Could not verify whether the balance credit committed. The deal remains reserved; retry to reconcile it safely." };
    }
    ledgerTxId = recovered[0]?.id ?? null;
    recoveredAfterAmbiguousOutcome = ledgerTxId != null;
    if (!ledgerTxId) {
      const safeError = safeCreditError(error);
      await adminDrizzle.transaction(async (tx) => {
        await queryRows(tx, `SELECT id FROM creator_pnl_deals WHERE id=$1::uuid FOR UPDATE`, deal.id);
        const failed = await queryRows<Array<{ id: string }>>(tx,
          `UPDATE creator_pnl_deals SET credit_status='failed',
            credit_error=$2, version=version+1, updated_at=now()
            WHERE id=$1::uuid AND status='crediting' AND credit_ledger_id IS NULL
            RETURNING id::text`,
          deal.id, safeError);
        if (failed[0]) {
          await queryRows(tx,
            `INSERT INTO admin_audit_events (admin_user_id,event_type,target_user_id,metadata)
             VALUES ($1::uuid,'creator_pnl_share_credit_failed',$2,$3::jsonb)`,
            session.userId, data.userId, JSON.stringify({
              dealId: deal.id,
              contractualAmountUsd: payoutAmountUsd,
              externalTxId,
              failureStage: "balance_credit",
              errorCode: "balance_credit_rejected",
              trigger: "manual_admin",
              surface: "creator_hub",
            }));
        }
      });
      return { success: false, error: safeError };
    }
  }

  const ledgerRows = await queryRows<Array<{
    id: string; amount: string; balance_before: string; balance_after: string; created_at: string;
  }>>(
    await getPrimaryDrizzleDb(),
    `SELECT id::text,amount::text,balance_before::text,balance_after::text,created_at::text
       FROM ledger_transactions
      WHERE id=$1::uuid AND external_tx_id=$2 AND user_id=$3
        AND type::text='admin_balance_adjustment' AND status='completed'
        AND amount::numeric=$4::numeric
        AND metadata->>'adjustment_category'='creator_pnl_share'
        AND metadata->>'creator_pnl_deal_id'=$5 LIMIT 1`,
    ledgerTxId, externalTxId, data.userId, payoutAmountUsd, deal.id,
  );
  const ledger = ledgerRows[0];
  if (!ledger) {
    return { success: false, error: "The credited ledger transaction did not match the frozen payout. The deal remains reserved for investigation." };
  }
  await adminDrizzle.transaction(async (tx) => {
    await queryRows(tx, `SELECT id FROM creator_pnl_deals WHERE id=$1::uuid FOR UPDATE`, deal.id);
    const finalized = await queryRows<Array<{ id: string }>>(tx,
      `UPDATE creator_pnl_deals SET status='settled', credit_status='credited',
        credit_error=NULL, credit_ledger_id=$2,
        credited_by_admin_user_id=$3::uuid,
        credited_at=COALESCE(credited_at,now()), settled_at=COALESCE(settled_at,now()),
        version=version+1, updated_at=now()
        WHERE id=$1::uuid AND status IN ('crediting','settled')
        RETURNING id::text`, deal.id, ledger.id, session.userId);
    if (!finalized[0]) throw new Error("PnL deal left the crediting state before settlement finalized.");
    if (recoveredAfterAmbiguousOutcome) {
      await queryRows(tx,
        `INSERT INTO admin_audit_events (admin_user_id,event_type,target_user_id,metadata)
         VALUES ($1::uuid,'creator_pnl_share_credit_reconciled',$2,$3::jsonb)`,
        session.userId, data.userId, JSON.stringify({
          dealId: deal.id,
          contractualAmountUsd: payoutAmountUsd,
          externalTxId,
          ledgerTxId: ledger.id,
          recoveryReason: "ambiguous_balance_writer_outcome",
          trigger: "manual_admin",
          surface: "creator_hub",
        }));
    }
    await queryRows(tx,
      `INSERT INTO admin_audit_events (admin_user_id,event_type,target_user_id,metadata)
       SELECT $1::uuid,'creator_pnl_share_credited',$2,$3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_audit_events
           WHERE event_type='creator_pnl_share_credited'
             AND metadata->>'dealId'=$4
        )`,
      session.userId, data.userId, JSON.stringify({
        dealId: deal.id,
        sourceApprovalRequestId: deal.source_approval_request_id,
        amountUsd: payoutAmountUsd,
        contractualAmountUsd: payoutAmountUsd,
        deviationUsd: 0,
        ledgerTxId: ledger.id,
        ledgerCreatedAt: ledger.created_at,
        balanceBeforeUsd: Number(ledger.balance_before),
        balanceAfterUsd: Number(ledger.balance_after),
        externalTxId,
        settlementReason,
        reservedByAdminUserId,
        frameStartAt: deal.frame_start_utc,
        frameEndAt: deal.frame_end_utc,
        positivePnlShareBps: deal.positive_pnl_share_bps,
        frameSitePnlUsd: preview.frame_site_pnl_usd,
        computationVersion: preview.computation_version,
        calculatedAt: preview.computed_at,
        fundingMode: deal.funding_mode,
        trigger: "manual_admin",
        surface: "creator_hub",
        stepUpVerified: true,
        immediatelyWithdrawable: true,
        recoveredAfterAmbiguousOutcome,
      }), deal.id);
  });
  invalidate(data.userId);
  return { success: true, ledgerTxId: ledger.id, amountUsd: payoutAmountUsd };
}

const CalculateSchema = z.object({
  userId: z.string().trim().min(8).max(128), dealId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export async function calculateCreatorPnlAction(input: z.input<typeof CalculateSchema>) {
  const session = await requireCreatorHubAccess("Not authorized to calculate creator PnL.");
  await requireCapability(session, "__can_create_creator_deal", "calculate creator PnL settlements");
  const parsed = CalculateSchema.safeParse(input);
  if (!parsed.success) return { success: false as const, error: "Invalid PnL deal." };
  const deal = await getAdminCreatorPnlDeal(parsed.data.userId, parsed.data.dealId);
  if (!deal) return { success: false as const, error: "PnL deal not found." };
  if (new Date(deal.frame_end_utc).getTime() > Date.now()) {
    return { success: false as const, error: "The PnL frame has not ended." };
  }
  if (!["scheduled", "active", "settlement_pending"].includes(deal.status)) {
    return { success: false as const, error: `PnL deal cannot be calculated from ${deal.status}.` };
  }
  let preview;
  try { preview = await computeCreatorPnlPreview(deal); }
  catch (error) { return { success: false as const, error: error instanceof Error ? error.message : "Frame calculation failed." }; }
  if (preview.creator_own_gameplay_status === "ambiguous") {
    return { success: false as const, error: `Creator own-play is ambiguous: ${preview.creator_own_gameplay_note}` };
  }
  const creatorShareUsd = roundSettlementMoney(
    Math.max(0, preview.frame_site_pnl_usd) * deal.positive_pnl_share_bps / 10_000,
  );
  const updated = await queryRows<Array<{ version: number }>>(adminDrizzle,
    `UPDATE creator_pnl_deals SET status='calculated', credit_status='ready',
      frame_site_pnl_usd=$4::numeric, creator_share_usd=$5::numeric,
      settlement_breakdown=$6::jsonb, calculation_started_at=COALESCE(calculation_started_at,now()),
      calculated_at=now(), credit_error=NULL, version=version+1, updated_at=now()
      WHERE id=$1::uuid AND creator_user_id=$2 AND version=$3
        AND status IN ('scheduled','active','settlement_pending')
      RETURNING version`, deal.id, parsed.data.userId, parsed.data.expectedVersion,
    preview.frame_site_pnl_usd, creatorShareUsd, JSON.stringify(preview));
  if (!updated[0]) return { success: false as const, error: "PnL deal changed. Refresh and retry." };
  await createAdminAuditEventDurable({ adminUserId: session.userId,
    eventType: "creator_pnl_deal_calculated", targetUserId: parsed.data.userId,
    metadata: {
      dealId: deal.id,
      sourceApprovalRequestId: deal.source_approval_request_id,
      frameSitePnlUsd: preview.frame_site_pnl_usd,
      creatorShareUsd,
      positivePnlShareBps: deal.positive_pnl_share_bps,
      frameStartAt: deal.frame_start_utc,
      frameEndAt: deal.frame_end_utc,
      computationVersion: preview.computation_version,
      computedAt: preview.computed_at,
      fundingMode: deal.funding_mode,
      breakdown: preview,
      trigger: "manual_admin",
      surface: "creator_hub",
    } });
  invalidate(parsed.data.userId);
  return { success: true as const, frameSitePnlUsd: preview.frame_site_pnl_usd, creatorShareUsd };
}

const CancelSchema = z.object({ userId: z.string().min(8).max(128), dealId: z.string().uuid(), reason: z.string().trim().min(3).max(500) });
export async function cancelCreatorPnlDealAction(input: z.input<typeof CancelSchema>) {
  const session = await requireCreatorHubAccess("Not authorized to cancel creator PnL deals.");
  await requireCapability(session, "__can_create_creator_deal", "cancel creator PnL deals");
  const parsed = CancelSchema.safeParse(input);
  if (!parsed.success) return { success: false as const, error: "Enter a cancellation reason." };
  const deal = await getAdminCreatorPnlDeal(parsed.data.userId, parsed.data.dealId);
  if (!deal || !["scheduled", "active", "settlement_pending", "calculated"].includes(deal.status)) {
    return { success: false as const, error: "This PnL deal can no longer be cancelled." };
  }
  const links = deal.source_approval_request_id ? await queryRows<Array<{ leaderboard_id: string | null; reward_program_id: string | null }>>(adminDrizzle,
    `SELECT leaderboard_id::text,reward_program_id::text FROM creator_deal_approval_requests WHERE id=$1::uuid`, deal.source_approval_request_id) : [];
  try {
    if (deal.linked_fill_deal_id) await requireCapability(session, "__can_delete_creator_deal", "cancel PnL fill funding");
    if (deal.funding_mode === "new_multiplier") await requireCapability(session, "__can_create_multiplier_deal", "cancel PnL multiplier funding");
    if (links[0]?.leaderboard_id) await requireCapability(session, "__can_approve_leaderboard", "cancel the bundled leaderboard");
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Missing cancellation permission." };
  }
  try {
    if (deal.linked_fill_deal_id) {
      const fill = await creatorsApi.getDeal(parsed.data.userId, deal.linked_fill_deal_id);
      if (!["completed", "terminated"].includes(fill.status)) await creatorsApi.terminateDeal(parsed.data.userId, deal.linked_fill_deal_id, { reason: parsed.data.reason, force_end_active_session: true });
    }
    if (deal.linked_multiplier_deal_id && deal.funding_mode === "new_multiplier") {
      const multiplier = await multiplierDealsApi.get(parsed.data.userId, deal.linked_multiplier_deal_id);
      if (!["cancelled", "completed", "approved", "rejected"].includes(multiplier.status)) await multiplierDealsApi.cancel(parsed.data.userId, deal.linked_multiplier_deal_id, { reason: parsed.data.reason });
    }
    if (links[0]?.leaderboard_id) {
      const leaderboard = await affiliateLeaderboardsApi.get(links[0].leaderboard_id);
      if (!leaderboard.cancelled_at) await affiliateLeaderboardsApi.cancel(links[0].leaderboard_id, session.userId);
    }
  } catch (error) {
    return { success: false as const, error: `Could not cancel all bundled deal resources: ${error instanceof Error ? error.message : "unknown error"}. Retry to reconcile partial cancellation.` };
  }
  if (links[0]?.reward_program_id) {
    await adminDrizzle.transaction(async (tx) => {
      await queryRows(tx, `UPDATE creator_reward_programs SET is_active=false,updated_at=now() WHERE id=$1::uuid`, links[0]!.reward_program_id);
      await queryRows(tx, `UPDATE creator_reward_program_windows SET ended_at=COALESCE(ended_at,now()) WHERE program_id=$1::uuid AND ended_at IS NULL`, links[0]!.reward_program_id);
    });
  }
  const updated = await queryRows<Array<{ id: string }>>(adminDrizzle,
    `UPDATE creator_pnl_deals SET status='cancelled', cancelled_at=now(),
      cancellation_reason=$3, version=version+1, updated_at=now()
      WHERE id=$1::uuid AND creator_user_id=$2
        AND status IN ('scheduled','active','settlement_pending','calculated') RETURNING id::text`,
    parsed.data.dealId, parsed.data.userId, parsed.data.reason);
  if (!updated[0]) return { success: false as const, error: "This PnL deal can no longer be cancelled." };
  await createAdminAuditEventDurable({ adminUserId: session.userId,
    eventType: "creator_pnl_deal_cancelled", targetUserId: parsed.data.userId,
    metadata: { dealId: parsed.data.dealId, reason: parsed.data.reason,
      preservedLinkedMultiplierDealId: deal.funding_mode === "linked_multiplier" ? deal.linked_multiplier_deal_id : null } });
  invalidate(parsed.data.userId);
  return { success: true as const };
}
