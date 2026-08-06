import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator deal approval is durable, identity-bound, and recoverable", async () => {
  const [migration, workflow, terms, claim, ack, respond, continueRoute, decisionRoute, endpoints] = await Promise.all([
    read("drizzle/admin/migrations/20260806_creator_deal_approval_workflow.sql"),
    read("src/lib/creator-deal-approvals.ts"),
    read("src/lib/creator-agreement-terms.ts"),
    read("src/app/api/v1/discord/creator-deal-approvals/jobs/claim/route.ts"),
    read("src/app/api/v1/discord/creator-deal-approvals/jobs/[id]/ack/route.ts"),
    read("src/app/api/v1/discord/creator-deal-approvals/respond/route.ts"),
    read("src/app/api/v1/discord/creator-deal-approvals/[requestId]/continue/route.ts"),
    read("src/app/api/v1/discord/creator-deal-approvals/[requestId]/decision/route.ts"),
    read("src/lib/api-auth/endpoints.ts"),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_agreement_documents/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_agreement_lines/);
  assert.match(migration, /creator_deal_approval_one_unresolved_creator/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_deal_approval_events/);
  assert.match(migration, /creator_deal_approval_events_interaction_unique/);
  assert.match(migration, /source_approval_request_id UUID/);
  assert.match(migration, /creator_reward_programs_source_approval_unique/);
  assert.match(migration, /creator_reward_programs_end_after_start/);

  assert.match(terms, /createHash\("sha256"\)/);
  assert.match(terms, /pg_advisory_xact_lock/);
  assert.match(terms, /creator_agreement_terms_published/);
  assert.match(terms, /export async function getPublishedCreatorAgreementTerms/);
  assert.match(terms, /export async function listCreatorAgreementTermVersions/);
  assert.match(terms, /export async function publishCreatorAgreementTerms/);

  assert.match(workflow, /export async function createCreatorDealApprovalRequest/);
  assert.match(workflow, /Deal start must be 00:00 UTC/);
  assert.match(workflow, /already has an unresolved deal approval/);
  assert.match(workflow, /agreement_checksum: agreement\.checksum/);
  assert.match(workflow, /FOR UPDATE SKIP LOCKED/);
  assert.match(workflow, /delivery_lease_token = gen_random_uuid/);
  assert.match(workflow, /summary_delivery_failed/);
  assert.match(workflow, /export async function retryCreatorDealApprovalDelivery/);
  assert.match(workflow, /summary_delivery_requeued/);
  assert.match(workflow, /resolveLinkedSiteAdmin\(parsed\.actorDiscordUserId\)/);
  assert.match(workflow, /eq\(account\.providerId, "discord"\)/);
  assert.match(workflow, /linked\.role !== "admin"/);
  assert.match(workflow, /parsed\.action === "decline" && actor\.kind !== "creator"/);
  assert.match(workflow, /approvalActor: actor\.kind/);
  assert.doesNotMatch(workflow, /isDiscordBotSuperuser/);
  assert.match(workflow, /request\.summary_message_id !== parsed\.messageId/);
  assert.match(workflow, /creator_deal_approval_events\.interaction_id/);
  assert.match(workflow, /creator_approval_request_id: request\.id/);
  assert.match(workflow, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(workflow, /const listed = await listAllCreatorDeals/);
  assert.match(workflow, /deal\.status === "active" \|\| deal\.status === "scheduled"/);
  assert.match(workflow, /return existingStart < proposedEnd && proposedStart < existingEnd/);
  assert.match(workflow, /creator_deal_window_overlap/);
  const overlaps = (existingStart: number, existingEnd: number, proposedStart: number, proposedEnd: number) =>
    existingStart < proposedEnd && proposedStart < existingEnd;
  assert.equal(overlaps(0, 10, 10, 20), false, "back-to-back end == start must be allowed");
  assert.equal(overlaps(10, 20, 0, 10), false, "back-to-back start == end must be allowed");
  assert.equal(overlaps(0, 11, 10, 20), true, "one-unit intersection must be rejected");
  assert.equal(overlaps(10, 20, 0, 11), true, "reverse one-unit intersection must be rejected");
  assert.ok(
    workflow.indexOf("pg_advisory_xact_lock(hashtextextended") < workflow.indexOf("const listed = await listAllCreatorDeals")
      && workflow.indexOf("const listed = await listAllCreatorDeals") < workflow.indexOf("creatorsApi.createDeal"),
    "the per-creator lock and overlap read must happen before create",
  );
  assert.match(workflow, /source_approval_request_id: request\.id/);
  assert.match(workflow, /Math\.max\(new Date\(deal\.week_start_utc\)\.getTime\(\), approvedAt\.getTime\(\)\)/);
  assert.match(workflow, /status = 'provisioning_failed'/);
  assert.match(workflow, /status = 'completed'/);
  assert.match(workflow, /conversionRatePercent/);
  assert.match(workflow, /accrualStartAt/);
  assert.match(workflow, /endsAt: dealPayload\.week_end_utc/);
  assert.match(workflow, /const end = new Date\(deal\.week_end_utc\)/);
  assert.doesNotMatch(workflow, /new Date\(reward\.endsAt \?\?/);
  assert.match(workflow, /continueAdjacentRewardProgram/);
  assert.match(workflow, /ends_at = \$\{input\.deal\.week_start_utc\}::timestamptz/);
  assert.match(workflow, /rewardProgramsCanContinue/);
  assert.match(workflow, /event_type: "reward_program_continued"/);
  assert.match(workflow, /reward_program_id: prior\.id/);

  for (const route of [claim, ack, respond, continueRoute, decisionRoute]) {
    assert.match(route, /scopes: \["discord:creator:setup"\]/);
  }
  assert.match(claim, /claimCreatorDealApprovalJobs/);
  assert.match(ack, /acknowledgeCreatorDealApprovalJob/);
  assert.match(respond, /respondToCreatorDealApproval/);
  assert.match(respond, /action: z\.enum\(\["continue", "approve", "decline"\]\)/);
  assert.match(continueRoute, /action: "continue"/);
  assert.match(decisionRoute, /action: z\.enum\(\["approve", "decline"\]\)/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deal-approvals\/jobs\/claim/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deal-approvals\/jobs\/\[id\]\/ack/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deal-approvals\/respond/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deal-approvals\/\[requestId\]\/continue/);
  assert.match(endpoints, /\/api\/v1\/discord\/creator-deal-approvals\/\[requestId\]\/decision/);
});
