import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detectorPath = "src/lib/antifraud/reward-abuse.ts";
const actionPath = "src/app/(antifraud)/antifraud/reward-abuse/actions.ts";

test("rain abuse detection is review-only and Discord alerts are batched", async () => {
  const detector = await readFile(detectorPath, "utf8");
  assert.match(detector, /runRainAbuseDetection/);
  assert.match(detector, /discord_alerted_at IS NULL/);
  assert.match(detector, /rain-abuse-batch:/);
  assert.doesNotMatch(detector, /No reward access was changed automatically/);
  assert.doesNotMatch(detector, /name: "Staff action"/);
  assert.doesNotMatch(detector, /updateUserRewardLocks/);
  assert.equal(
    detector.match(/enqueueDiscordEvent\(\{/g)?.length,
    1,
    "one detector run must enqueue one notification batch, not one alert per review",
  );
  assert.ok(
    detector.indexOf("for (const candidate of candidates)") <
      detector.indexOf("enqueueDiscordEvent({"),
    "all qualifying accounts must be persisted before the single batch is queued",
  );
  assert.match(detector, /value: String\(batch\.length\)/);
});

test("failed or unrouted Discord delivery leaves reviews retryable", async () => {
  const detector = await readFile(detectorPath, "utf8");
  assert.match(detector, /queued\.enqueued > 0 \|\| queued\.duplicate > 0/);
  assert.match(detector, /SET discord_alerted_at = now\(\)/);
});

test("only a confirmed manual decision adds the Rain reward lock", async () => {
  const action = await readFile(actionPath, "utf8");
  assert.match(action, /decision === "confirm"/);
  assert.match(action, /requireCapability[\s\S]*__can_toggle_feature_locks/);
  assert.match(action, /requireCapability[\s\S]*__can_adjust_balance/);
  assert.match(action, /require2FA\(session\.userId, credential \?\? ""\)/);
  assert.ok(
    action.indexOf("require2FA(session.userId") <
      action.indexOf("adminDrizzle.transaction"),
    "step-up must complete before any confirmation side effect",
  );
  assert.match(action, /getUserFeatureLocks/);
  assert.match(action, /updateUserRewardLocks/);
  assert.match(action, /\.\.\.current\.locked_reward_categories/);
  assert.match(action, /review\.status !== "pending"/);
  assert.match(action, /pg_advisory_xact_lock/);
});

test("confirmation caps an idempotent admin-owned Rain forfeiture", async () => {
  const action = await readFile(actionPath, "utf8");
  const client = await readFile("src/lib/backend-api/feature-locks.ts", "utf8");
  assert.match(action, /forfeitRainAttributableBalance/);
  assert.match(action, /Math\.min\([\s\S]*requestedCents[\s\S]*availableCents[\s\S]*bonusOtherCents/);
  assert.match(action, /reward-abuse:\$\{input\.reviewId\}:rain/);
  assert.match(action, /pg_advisory_xact_lock/);
  assert.match(action, /FOR UPDATE/);
  assert.match(action, /unwagered_bonus_other_usd = GREATEST/);
  assert.match(action, /available_balance = GREATEST/);
  assert.match(action, /external_tx_id/);
  assert.match(action, /adjustment_category: "fraud_abuse"/);
  assert.match(action, /reward_abuse_rain_forfeit/);
  assert.match(action, /decision === "dismiss" && await hasRainForfeitMarker\(reviewId\)/);
  assert.doesNotMatch(client, /reward-abuse\/rain-confirm/);
});

test("dismissed findings have a 30-day detector cooldown", async () => {
  const detector = await readFile(detectorPath, "utf8");
  assert.match(detector, /previous\.status IN \('confirmed', 'dismissed'\)/);
  assert.match(detector, /previous\.reviewed_at >= now\(\) - interval '30 days'/);
});

test("reward abuse page exposes explicit unambiguous staff decisions", async () => {
  const controls = await readFile(
    "src/app/(antifraud)/antifraud/reward-abuse/review-actions.tsx",
    "utf8",
  );
  assert.match(controls, /Confirm abuse & disable Rain/);
  assert.match(controls, /Dismiss finding/);
});

test("confirmation UI requires step-up while dismissal does not", async () => {
  const actions = await readFile(
    "src/app/(antifraud)/antifraud/reward-abuse/review-actions.tsx",
    "utf8",
  );
  assert.match(actions, /<StepUpField value=\{credential\} onChange=\{setCredential\} \/>/);
  assert.match(actions, /confirming && !credential\.trim\(\)/);
  assert.match(actions, /credential: confirming \? credential\.trim\(\) : undefined/);
});

test("reward evidence separates received tips from sponsored-battle value", async () => {
  const detector = await readFile(detectorPath, "utf8");
  assert.match(detector, /tx\.type::text = 'creator_tip'/);
  assert.match(detector, /metadata->>'direction' = 'received'/);
  assert.match(detector, /battle\.sponsorship_percentage/);
  assert.match(detector, /inventory\.source_id = participant\.game_session_id/);
  assert.match(detector, /voucher\.origin_id = participant\.game_session_id/);
});

test("reward evidence includes recent and lifetime completed withdrawals", async () => {
  const detector = await readFile(detectorPath, "utf8");
  assert.match(detector, /AS withdrawn_30d_usd/);
  assert.match(detector, /AS lifetime_withdrawn_usd/);
  assert.match(detector, /request\.status::text IN \('completed', 'shipped'\)/);
  assert.match(detector, /balance\.total_withdrawn/);
});

test("reward-funded withdrawals qualify even when rewards were recycled through play", async () => {
  const detector = await readFile(detectorPath, "utf8");
  assert.match(detector, /const rewardFundedWithdrawal/);
  assert.match(detector, /withdrawn30dUsd >= 10/);
  assert.match(detector, /!lowRealPlay && !paidPackPattern && !rewardFundedWithdrawal/);
});
