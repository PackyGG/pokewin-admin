import "server-only";

import { desc, eq, inArray, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import {
  creator_deal_approval_requests,
  creator_reward_claims,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";

export type CreatorRewardsDetail = Awaited<
  ReturnType<typeof getCreatorRewardsDetail>
>;

/** Creator-scoped read for the detail tab; never loads the global rewards queue. */
export async function getCreatorRewardsDetail(creatorUserId: string) {
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
    .select({
      id: creator_deal_approval_requests.id,
      rewardProgramId: creator_deal_approval_requests.reward_program_id,
    })
    .from(creator_deal_approval_requests)
    .where(eq(creator_deal_approval_requests.creator_user_id, creatorUserId))
    .orderBy(desc(creator_deal_approval_requests.created_at))
    .limit(100);

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
      .filter((request) => request.rewardProgramId)
      .map((request) => [request.rewardProgramId!, request.id]),
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
  };
}
