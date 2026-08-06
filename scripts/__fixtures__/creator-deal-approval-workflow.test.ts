import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("creator deal approval is durable, creator-only, and recoverable", async () => {
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
  assert.match(workflow, /request\.creator_discord_user_id !== parsed\.actorDiscordUserId/);
  assert.doesNotMatch(workflow, /isDiscordBotSuperuser/);
  assert.match(workflow, /request\.summary_message_id !== parsed\.messageId/);
  assert.match(workflow, /creator_deal_approval_events\.interaction_id/);
  assert.match(workflow, /creator_approval_request_id: request\.id/);
  assert.match(workflow, /listed\.data\.find\(\(deal\) => markerDeal/);
  assert.match(workflow, /source_approval_request_id: request\.id/);
  assert.match(workflow, /Math\.max\(new Date\(deal\.week_start_utc\)\.getTime\(\), approvedAt\.getTime\(\)\)/);
  assert.match(workflow, /status = 'provisioning_failed'/);
  assert.match(workflow, /status = 'completed'/);
  assert.match(workflow, /conversionRatePercent/);
  assert.match(workflow, /accrualStartAt/);

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
