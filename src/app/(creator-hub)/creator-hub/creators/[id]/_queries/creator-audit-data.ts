import "server-only";

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { auditActorVisibilityPredicate } from "@/lib/audit-visibility";
import {
  admin_audit_events,
  creator_deal_approval_events,
  creator_deal_approval_requests,
} from "@/lib/db-schema/admin/schema";

export type CreatorAuditDetail = Awaited<ReturnType<typeof getCreatorAuditDetail>>;

/** Creator-scoped approval requests and audit history, loaded only on the Audit tab. */
export async function getCreatorAuditDetail(
  creatorUserId: string,
  canViewProtectedActors: boolean,
) {
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
          .where(
            and(
              inArray(creator_deal_approval_events.request_id, requestIds),
              auditActorVisibilityPredicate(
                canViewProtectedActors,
                sql`${creator_deal_approval_events.actor_admin_user_id}`,
              ),
            ),
          )
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

  return {
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
