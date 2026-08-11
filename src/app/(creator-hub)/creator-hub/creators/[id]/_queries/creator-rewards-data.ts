import "server-only";

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_audit_events,
  creator_deal_approval_events,
  creator_deal_approval_requests,
  creator_reward_claims,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";
import { auditActorVisibilityPredicate } from "@/lib/audit-visibility";

export type CreatorRewardsDetail = Awaited<
  ReturnType<typeof getCreatorRewardsDetail>
>;

/** Creator-scoped read for the detail tab; never loads the global rewards queue. */
export async function getCreatorRewardsDetail(
  creatorUserId: string,
  canViewProtectedActors: boolean,
) {
  const programs = await adminDrizzle
    .select()
    .from(creator_reward_programs)
    .where(eq(creator_reward_programs.creator_user_id, creatorUserId))
    .orderBy(desc(creator_reward_programs.created_at));

  const programIds = programs.map((program) => program.id);
  const claimAggregates =
    programIds.length === 0
      ? []
      : await adminDrizzle
          .select({
            programId: creator_reward_claims.program_id,
            status: creator_reward_claims.status,
            count: sql<number>`count(*)::int`,
            amountUsd: sql<string>`coalesce(sum(${creator_reward_claims.amount_usd}), 0)::text`,
          })
          .from(creator_reward_claims)
          .where(inArray(creator_reward_claims.program_id, programIds))
          .groupBy(creator_reward_claims.program_id, creator_reward_claims.status);
  const claims =
    programIds.length === 0
      ? []
      : await adminDrizzle
          .select()
          .from(creator_reward_claims)
          .where(inArray(creator_reward_claims.program_id, programIds))
          .orderBy(desc(creator_reward_claims.requested_at))
          .limit(200);

  const approvalRequests = await adminDrizzle
    .select()
    .from(creator_deal_approval_requests)
    .where(eq(creator_deal_approval_requests.creator_user_id, creatorUserId))
    .orderBy(desc(creator_deal_approval_requests.created_at))
    .limit(100);
  const requestIds = approvalRequests.map((request) => request.id);
  const approvalEvents =
    requestIds.length === 0
      ? []
      : await adminDrizzle
          .select()
          .from(creator_deal_approval_events)
          .where(and(
            inArray(creator_deal_approval_events.request_id, requestIds),
            auditActorVisibilityPredicate(
              canViewProtectedActors,
              sql`${creator_deal_approval_events.actor_admin_user_id}`,
            ),
          ))
          .orderBy(desc(creator_deal_approval_events.created_at))
          .limit(300);

  const rewardAuditEvents = await adminDrizzle
    .select({
      id: admin_audit_events.id,
      eventType: admin_audit_events.event_type,
      createdAt: admin_audit_events.created_at,
      metadata: admin_audit_events.metadata,
    })
    .from(admin_audit_events)
    .where(
      and(
        eq(admin_audit_events.target_user_id, creatorUserId),
        like(admin_audit_events.event_type, "creator_reward_%"),
        auditActorVisibilityPredicate(canViewProtectedActors),
      ),
    )
    .orderBy(desc(admin_audit_events.created_at))
    .limit(200);

  const claimStatsByProgram = new Map<
    string,
    { pending: number; approved: number; rejected: number; paidUsd: number }
  >();
  for (const aggregate of claimAggregates) {
    const stats = claimStatsByProgram.get(aggregate.programId) ?? {
      pending: 0,
      approved: 0,
      rejected: 0,
      paidUsd: 0,
    };
    if (aggregate.status === "pending") stats.pending += aggregate.count;
    if (aggregate.status === "approved") {
      stats.approved += aggregate.count;
      stats.paidUsd += toNumber(aggregate.amountUsd);
    }
    if (aggregate.status === "rejected") stats.rejected += aggregate.count;
    claimStatsByProgram.set(aggregate.programId, stats);
  }

  const sourceRequestByProgram = new Map(
    approvalRequests
      .filter((request) => request.reward_program_id)
      .map((request) => [request.reward_program_id!, request.id]),
  );

  return {
    programs: programs.map((program) => ({
      id: program.id,
      name: program.name,
      codes: program.codes ?? [],
      isActive: program.is_active,
      accrualStartAt: new Date(program.accrual_start_at).toISOString(),
      endsAt: program.ends_at ? new Date(program.ends_at).toISOString() : null,
      createdAt: new Date(program.created_at).toISOString(),
      updatedAt: new Date(program.updated_at).toISOString(),
      thresholdUsd:
        program.threshold_usd == null ? null : toNumber(program.threshold_usd),
      rewardUsd:
        program.reward_usd == null ? null : toNumber(program.reward_usd),
      vipRewardUsd:
        program.vip_reward_usd == null ? null : toNumber(program.vip_reward_usd),
      lossbackPct:
        program.lossback_pct == null ? null : toNumber(program.lossback_pct),
      minDepositUsd:
        program.min_deposit_usd == null
          ? null
          : toNumber(program.min_deposit_usd),
      maxRewardPerUserUsd:
        program.max_reward_per_user_usd == null
          ? null
          : toNumber(program.max_reward_per_user_usd),
      stats: claimStatsByProgram.get(program.id) ?? {
        pending: 0,
        approved: 0,
        rejected: 0,
        paidUsd: 0,
      },
      sourceRequestId: sourceRequestByProgram.get(program.id) ?? null,
    })),
    claims: claims.map((claim) => ({
      id: claim.id,
      programId: claim.program_id,
      userId: claim.user_id,
      status: claim.status,
      leg: claim.leg,
      amountUsd: toNumber(claim.amount_usd),
      requestedAt: new Date(claim.requested_at).toISOString(),
      reviewedAt: claim.reviewed_at
        ? new Date(claim.reviewed_at).toISOString()
        : null,
      reviewNote: claim.review_note,
      ledgerTxId: claim.ledger_tx_id,
      botNotifiedAt: claim.bot_notified_at
        ? new Date(claim.bot_notified_at).toISOString()
        : null,
      botNotifyError: claim.bot_notify_error,
    })),
    approvalRequests: approvalRequests.map((request) => ({
      id: request.id,
      status: request.status,
      requestKind: request.request_kind,
      agreementVersion: request.agreement_version,
      hasPnlDeal: request.pnl_payload != null,
      pnlPayload: request.pnl_payload,
      hasRewardProgram: request.reward_payload != null,
      deliveryAttemptCount: request.delivery_attempt_count,
      provisioningAttemptCount: request.provisioning_attempt_count,
      continuedAt: request.continued_at,
      approvedAt: request.approved_at,
      declinedAt: request.declined_at,
      completedAt: request.completed_at,
      backendDealId: request.backend_deal_id,
      pnlDealId: request.pnl_deal_id,
      linkedFundingDealId:
        request.request_kind === "pnl_deal" ? request.backend_deal_id : null,
      rewardProgramId: request.reward_program_id,
      lastErrorStep: request.last_error_step,
      lastErrorCode: request.last_error_code,
      lastErrorMessage: request.last_error_message,
      createdAt: new Date(request.created_at).toISOString(),
      updatedAt: new Date(request.updated_at).toISOString(),
    })),
    approvalEvents: approvalEvents.map((event) => ({
      id: event.id,
      requestId: event.request_id,
      eventType: event.event_type,
      actorKind: event.actor_kind,
      actorAdminUserId: event.actor_admin_user_id,
      actorDiscordUserId: event.actor_discord_user_id,
      metadata: event.metadata,
      createdAt: new Date(event.created_at).toISOString(),
    })),
    rewardAuditEvents: rewardAuditEvents.map((event) => ({
      ...event,
      createdAt: new Date(event.createdAt).toISOString(),
    })),
  };
}
