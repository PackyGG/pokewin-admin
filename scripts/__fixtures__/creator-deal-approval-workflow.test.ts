import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildBackendDealPeriods } from "../../src/lib/creator-deal-periods";

const read = (path: string) => readFile(path, "utf8");

test("creator deal approval is durable, identity-bound, and recoverable", async () => {
  const [migration, leaderboardMigration, multiplierMigration, pnlMigration, workflow, adminSchema, historyQuery, backendIndex, terms, claim, ack, respond, continueRoute, decisionRoute, endpoints] = await Promise.all([
    read("drizzle/admin/migrations/20260806_creator_deal_approval_workflow.sql"),
    read("drizzle/admin/migrations/20260806_creator_deal_approval_leaderboard.sql"),
    read("drizzle/admin/migrations/20260811_creator_multiplier_deal_approval.sql"),
    read("drizzle/admin/migrations/20260812_creator_pnl_deal_approval.sql"),
    read("src/lib/creator-deal-approvals.ts"),
    read("src/lib/db-schema/admin/schema.ts"),
    read("src/app/(creator-hub)/creator-hub/creators/[id]/_queries/creator-audit-data.ts"),
    read("src/lib/backend-api/index.ts"),
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
  assert.match(workflow, /withdraw_cap_period_days: z\.union\(\[z\.literal\(7\), z\.literal\(14\)\]\)/);
  assert.match(workflow, /buildBackendDealPeriods\(payload\)/);
  assert.match(workflow, /creator_approval_period_index: period\.index/);
  assert.match(workflow, /creator_approval_period_count: period\.count/);
  assert.match(workflow, /for \(const period of periods\)/);
  assert.match(workflow, /already has an unresolved deal approval/);
  assert.match(workflow, /agreement_checksum: agreement\.checksum/);
  assert.match(workflow, /FOR UPDATE SKIP LOCKED/);
  assert.match(workflow, /delivery_lease_token = gen_random_uuid/);
  assert.match(workflow, /summary_delivery_failed/);
  assert.match(workflow, /export async function retryCreatorDealApprovalDelivery/);
  assert.match(workflow, /\["delivery_failed", "awaiting_continue", "awaiting_decision"\]\.includes\(previousStatus\)/);
  assert.match(workflow, /previousMessageId: row\.summary_message_id/);
  assert.match(workflow, /endsAt: deal\.week_end_utc/);
  assert.match(workflow, /summary_delivery_requeued/);
  assert.match(workflow, /endsAt: dealPayload \? dealPayload\.week_end_utc : windowEndIso/);
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
  const periods = (durationDays: number, capPeriodDays: 7 | 14 | null) =>
    buildBackendDealPeriods({
      week_start_utc: "2026-08-01T00:00:00.000Z",
      week_end_utc: new Date(Date.UTC(2026, 7, 1 + durationDays)).toISOString(),
      withdraw_cap_period_days: capPeriodDays,
      total_withdraw_cap_usd: 750,
      fills_allowed: 7,
    });
  assert.equal(periods(14, 7).length, 2, "a two-week deal with a weekly cap becomes two deals");
  assert.equal(periods(28, 7).length, 4, "a four-week deal with a weekly cap becomes four deals");
  assert.equal(periods(28, 14).length, 2, "a four-week deal with a two-week cap becomes two deals");
  assert.equal(periods(28, null).length, 1, "a full-duration cap remains one deal");
  assert.deepEqual(
    periods(14, 7).map((period) => [period.payload.week_start_utc, period.payload.week_end_utc]),
    [
      ["2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z"],
      ["2026-08-08T00:00:00.000Z", "2026-08-15T00:00:00.000Z"],
    ],
    "periods are exactly adjacent and never overlap",
  );
  assert.equal("withdraw_cap_period_days" in periods(14, 7)[0].payload, false, "UI-only period metadata is not sent to the backend");
  assert.ok(
    workflow.indexOf("pg_advisory_xact_lock(hashtextextended") < workflow.indexOf("const listed = await listAllCreatorDeals")
      && workflow.indexOf("const listed = await listAllCreatorDeals") < workflow.indexOf("creatorsApi.createDeal"),
    "the per-creator lock and overlap read must happen before create",
  );
  assert.match(workflow, /source_approval_request_id: request\.id/);
  assert.match(workflow, /Math\.max\(new Date\(request\.window_start_at\)\.getTime\(\), approvedAt\.getTime\(\)\)/);
  assert.match(workflow, /status = 'provisioning_failed'/);
  assert.match(workflow, /status = 'completed'/);
  assert.match(workflow, /conversionRatePercent/);
  assert.match(workflow, /accrualStartAt/);
  assert.match(workflow, /const end = new Date\(request\.window_end_at\)/);
  assert.doesNotMatch(workflow, /new Date\(reward\.endsAt \?\?/);
  assert.match(workflow, /continueAdjacentRewardProgram/);
  assert.match(workflow, /ends_at = \$\{input\.priorEndsAt\}::timestamptz/);
  assert.match(workflow, /rewardProgramsCanContinue/);
  assert.match(workflow, /event_type: "reward_program_continued"/);
  assert.match(workflow, /reward_program_id: prior\.id/);

  // Standalone leaderboard / rewards approvals: one payload each, no deal,
  // no terms step, and a leaderboard that is only ever provisioned once the
  // creator approves.
  assert.match(leaderboardMigration, /request_kind TEXT NOT NULL DEFAULT 'deal'/);
  assert.match(leaderboardMigration, /leaderboard_payload JSONB/);
  assert.match(leaderboardMigration, /leaderboard_id UUID/);
  assert.match(leaderboardMigration, /creator_deal_approval_kind_payload_check/);
  assert.match(leaderboardMigration, /ALTER COLUMN deal_payload DROP NOT NULL/);
  assert.match(leaderboardMigration, /window_start_at TIMESTAMPTZ\(6\)/);
  assert.match(leaderboardMigration, /window_end_at TIMESTAMPTZ\(6\)/);
  assert.match(leaderboardMigration, /deal_payload ->> 'week_start_utc'/);
  assert.match(leaderboardMigration, /\(creator_user_id, request_kind\)/);
  assert.match(workflow, /const LeaderboardPayloadSchema/);
  assert.match(workflow, /export type CreatorApprovalRequestKind = "deal" \| "multiplier_deal" \| "pnl_deal" \| "leaderboard_only" \| "rewards_only"/);
  assert.match(workflow, /async function ensureLeaderboard/);
  assert.match(workflow, /affiliateLeaderboardsApi\.create/);
  assert.match(workflow, /if \(request\.leaderboard_id\) return request\.leaderboard_id/);
  assert.match(workflow, /findProvisionedLeaderboard/);
  assert.match(workflow, /leaderboard_reconciliation_ambiguous/);
  assert.match(workflow, /codes: await loadAllCreatorCodes\(creatorUserId\)/);
  assert.match(workflow, /startsAt: windowStartIso/);
  assert.match(workflow, /request_kind IN \('deal', 'multiplier_deal', 'pnl_deal'\)/);
  assert.match(workflow, /kind === "deal" \|\| kind === "pnl_deal" \|\| kind === "rewards_only" \? await ensureRewardProgram/);
  assert.match(workflow, /kind === "deal" \|\| kind === "pnl_deal" \|\| kind === "leaderboard_only" \? await ensureLeaderboard/);
  assert.match(workflow, /new Date\(request\.window_end_at\)\.getTime\(\) <= Date\.now\(\)/);
  assert.match(workflow, /transition\.request_kind !== "deal" && transition\.request_kind !== "multiplier_deal" && transition\.request_kind !== "pnl_deal"/);
  assert.match(multiplierMigration, /multiplier_payload JSONB/);
  assert.match(multiplierMigration, /request_kind IN \('deal', 'multiplier_deal'\)/);
  assert.match(multiplierMigration, /creator_deal_approval_one_unresolved_creator/);
  assert.match(workflow, /async function ensureBackendMultiplierDeal/);
  assert.match(workflow, /multiplierDealsApi\.create/);
  assert.match(workflow, /terms_version: marker/);

  // First-class P&L deals share the unresolved deal-family slot, preserve an
  // immutable frame/funding snapshot in ADMIN. Only the ordinary funding
  // fill/multiplier is provisioned through an existing backend API.
  assert.match(pnlMigration, /ADD COLUMN IF NOT EXISTS pnl_payload JSONB/);
  assert.match(pnlMigration, /request_kind IN \('deal', 'multiplier_deal', 'pnl_deal'\)/);
  assert.match(pnlMigration, /request_kind = 'pnl_deal'/);
  assert.match(pnlMigration, /pnl_payload IS NOT NULL/);
  assert.match(workflow, /const PnlPayloadSchema/);
  assert.match(workflow, /positive_pnl_share_bps: z\.number\(\)\.int\(\)\.min\(1\)\.max\(10_000\)/);
  assert.match(workflow, /type: z\.literal\("non_withdrawable_fills"\)/);
  assert.match(workflow, /type: z\.literal\("linked_multiplier"\)/);
  assert.match(workflow, /type: z\.literal\("new_multiplier"\)/);
  assert.match(workflow, /multiplier_bps: z\.number\(\)\.int\(\)\.min\(20_000\)/);
  assert.match(workflow, /\.max\(2_147_000_000\)/);
  assert.match(workflow, /auto_renew: z\.literal\(false\)/);
  assert.match(workflow, /pnlPayload\?: unknown \| null/);
  assert.match(workflow, /kind === "deal" \|\| kind === "multiplier_deal" \|\| kind === "pnl_deal"/);
  assert.match(workflow, /request\.request_kind, request\.deal_payload, request\.multiplier_payload, request\.pnl_payload/);
  assert.match(pnlMigration, /CREATE TABLE IF NOT EXISTS creator_pnl_deals/);
  assert.match(pnlMigration, /source_approval_request_id UUID NOT NULL UNIQUE/);
  assert.match(pnlMigration, /funding_config JSONB NOT NULL/);
  assert.match(pnlMigration, /status IN \('scheduled', 'active', 'settlement_pending', 'calculated', 'crediting', 'settled', 'cancelled'\)/);
  assert.match(pnlMigration, /credit_idempotency_key TEXT NOT NULL/);
  assert.match(pnlMigration, /credit_idempotency_key = 'creator-pnl:' \|\| id::text/);
  assert.match(pnlMigration, /credit_attempted_at TIMESTAMPTZ\(6\)/);
  assert.match(pnlMigration, /credit_error TEXT/);
  assert.match(pnlMigration, /credited_amount_usd NUMERIC\(20, 2\)/);
  assert.match(pnlMigration, /credit_ledger_id UUID/);
  assert.match(pnlMigration, /settlement_breakdown JSONB/);
  assert.match(pnlMigration, /settlement_reason TEXT/);
  assert.match(pnlMigration, /guard_creator_pnl_deal_immutable_contract/);
  assert.match(pnlMigration, /BEFORE UPDATE ON creator_pnl_deals/);
  assert.match(adminSchema, /export const creator_pnl_deals = pgTable\(\s*"creator_pnl_deals"/);
  assert.match(workflow, /async function ensureAdminPnlDeal/);
  assert.match(workflow, /creator_pnl_deals\.source_approval_request_id/);
  assert.match(workflow, /credit_idempotency_key: `creator-pnl:\$\{pnlDealId\}`/);
  assert.match(workflow, /backend_create_attempted_at/);
  assert.match(workflow, /backend_create_unconfirmed/);
  assert.match(workflow, /hasPnlDeal: pnlPayload != null/);
  assert.match(workflow, /backend_pnl_funding/);
  assert.match(workflow, /admin_pnl_deal/);
  assert.match(workflow, /conversion_rate_bps: 0/);
  assert.match(workflow, /total_withdraw_cap_usd: null/);
  assert.match(workflow, /auto_renew: false/);
  assert.match(workflow, /linked\.multiplier_bps < 20_000/);
  assert.match(workflow, /linked\.auto_end_at/);
  assert.match(workflow, /export async function advanceDueCreatorPnlDeals/);
  assert.match(workflow, /status: "settlement_pending"/);
  assert.match(workflow, /terms_version: marker/);
  assert.match(workflow, /kind === "deal" \|\| kind === "pnl_deal" \|\| kind === "rewards_only"/);
  assert.match(workflow, /kind === "deal" \|\| kind === "pnl_deal" \|\| kind === "leaderboard_only"/);
  assert.match(workflow, /terms_text: z\.array\(z\.string\(\)\)\.parse\(request\.agreement_lines\)\.join\("\\n"\)/);
  assert.match(workflow, /terms_version: marker/);
  assert.match(historyQuery, /pnlDealId: request\.pnl_deal_id/);
  assert.match(historyQuery, /linkedFundingDealId/);
  assert.doesNotMatch(backendIndex, /pnlDealsApi|pnl-deals/);
  assert.doesNotMatch(workflow, /pnlDealsApi|\/pnl-deals/);
  assert.match(endpoints, /Jobs expose the immutable proposal under deal, multiplier, pnl, rewards, or leaderboard/);
  // Never re-derive the deal window from a payload that may not exist.
  assert.doesNotMatch(workflow, /DealPayloadSchema\.parse\(request\.deal_payload\)\.week_end_utc/);

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
