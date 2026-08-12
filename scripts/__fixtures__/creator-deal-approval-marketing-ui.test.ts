import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const detail = "src/app/(creator-hub)/creator-hub/creators/[id]";

test("new creator deal chooses fill, multiplier, or P&L and never creates before approval", () => {
  const dialog = read(`${detail}/_components/new-deal-dialog.tsx`);
  const action = read(`${detail}/_components/deal-approval-actions.ts`);
  const fields = read(`${detail}/_components/deal-form-shared.tsx`);
  const pnlFields = read(`${detail}/_components/pnl-deal-approval-fields.tsx`);

  assert.match(dialog, /"type" \| "deal" \| "multiplier" \| "pnl" \| "rewards" \| "leaderboard" \| "confirm" \| "queued"/);
  assert.match(dialog, /Fill deal/);
  assert.match(dialog, /Multiplier deal/);
  assert.match(dialog, /PnL deal/);
  assert.match(dialog, /multiplierPayload/);
  assert.match(dialog, /pnlPayload/);
  assert.match(dialog, /Skip rewards/);
  assert.match(dialog, /Skip leaderboard/);
  assert.match(dialog, /leaderboardPayload/);
  assert.match(dialog, /submitCreatorDealApproval/);
  assert.match(dialog, /formatDate\(dealPayload\.week_start_utc, "UTC"\)/);
  assert.doesNotMatch(dialog, /formatDateTime\(dealPayload\.week_start_utc/);
  assert.match(dialog, /label="Program ends" value=\{formatDate\(dealPayload\.week_end_utc, "UTC"\)\}/);
  assert.doesNotMatch(dialog, /createCreatorDeal\(|createCreatorRewardProgram\(/);
  // The creator is obvious from the page — no identity box inside the wizard.
  assert.doesNotMatch(dialog, /creatorLabel/);
  assert.doesNotMatch(read(`${detail}/_components/creator-reward-draft-fields.tsx`), /creatorLabel/);
  assert.match(action, /createCreatorDealApprovalRequest/);
  assert.doesNotMatch(action, /createCreatorDeal\(|createCreatorRewardProgram\(/);

  assert.match(pnlFields, /positive_pnl_share_bps/);
  assert.match(pnlFields, /"non_withdrawable_fills"/);
  assert.match(pnlFields, /"new_multiplier"/);
  assert.match(pnlFields, /auto_renew: false/);
  assert.match(dialog, /dealType === "fill" \|\| dealType === "pnl" \? rewardPayload : null/);
  assert.match(dialog, /dealType === "fill" \|\| dealType === "pnl" \? leaderboardPayload : null/);

  assert.match(fields, /type=\{mode === "create" \? "date" : "datetime-local"\}/);
  assert.match(fields, /T00:00:00/);
  assert.match(fields, /isLocalDateTime/);
  assert.match(fields, /isDateOnly \|\| isLocalDateTime \? `\$\{withSeconds\}Z` : withSeconds/);
  assert.match(fields, /\[7, 14, 21, 28\]/);
  assert.match(fields, /duration_preset === "custom"/);
  assert.match(fields, /cooldown_minutes: "300"/);
  assert.match(fields, /withdraw_cap_mode/);
  assert.match(fields, /choose No limit/i);
  assert.match(fields, /forceLeaderboardsOff/);
  assert.doesNotMatch(fields, /title="Leaderboards"/);
  assert.doesNotMatch(fields, /Include in packy\.gg official races/);
  assert.doesNotMatch(fields, /Creator-run leaderboards/);
});

test("creator detail separates reward programs from an active-tab-only audit page", () => {
  const page = read(`${detail}/page.tsx`);
  const tabs = read(`${detail}/_components/creator-tab-bar.tsx`);
  const rewardsQuery = read(`${detail}/_queries/creator-rewards-data.ts`);
  const rewardsView = read(`${detail}/_components/rewards-tab.tsx`);
  const auditQuery = read(`${detail}/_queries/creator-audit-data.ts`);
  const auditView = read(`${detail}/_components/audit-tab.tsx`);

  assert.match(page, /"rewards"/);
  assert.match(page, /"alts",\s*"audit"/);
  assert.match(page, /tab === "rewards" && <CreatorRewardsTab/);
  assert.match(page, /tab === "audit" && \(\s*<CreatorAuditTab/);
  assert.match(tabs, /key: "rewards", label: "Rewards"/);
  assert.match(tabs, /key: "alts", label: "Alt Accounts"[\s\S]*key: "audit", label: "Audit"/);
  assert.match(rewardsQuery, /creator_reward_programs\.creator_user_id, creatorUserId/);
  assert.match(rewardsQuery, /groupBy\(creator_reward_claims\.program_id, creator_reward_claims\.status\)/);
  assert.doesNotMatch(rewardsView, /Deal approval requests|Program and approval log/);
  assert.match(auditQuery, /creator_deal_approval_requests\.creator_user_id/);
  assert.match(auditQuery, /creator_deal_approval_events\.request_id/);
  assert.match(auditQuery, /auditActorVisibilityPredicate/);
  assert.match(page, /canViewProtectedActors=\{canViewProtectedAuditActivity\(session\)\}/);
  assert.match(auditView, /Delivery attempts/);
  assert.match(auditView, /Provision attempts/);
  assert.match(rewardsView, /botNotifyError/);
  assert.match(rewardsView, /ledgerTxId/);
});

test("Creator Hub terms route publishes immutable numbered versions", () => {
  const sidebar = read("src/app/(creator-hub)/creator-hub/_components/creator-hub-sidebar.tsx");
  const hosts = read("src/lib/app-hosts.ts");
  const page = read("src/app/(creator-hub)/creator-hub/tos/page.tsx");
  const editor = read("src/app/(creator-hub)/creator-hub/tos/terms-editor.tsx");
  const actions = read("src/app/(creator-hub)/creator-hub/tos/actions.ts");

  assert.match(sidebar, /href: "\/creator-hub\/tos"/);
  assert.match(hosts, /"tos"/);
  assert.match(page, /listCreatorAgreementTermVersions/);
  assert.match(editor, /\{index \+ 1\}\./);
  assert.match(editor, /Publish new version/);
  assert.match(actions, /publishCreatorAgreementTerms/);
  assert.match(actions, /actorAdminUserId: session\.userId/);
});
