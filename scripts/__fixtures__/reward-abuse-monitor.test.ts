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
  assert.match(action, /new Set\(\[\.\.\.current\.locked_reward_categories, "rain" as const\]\)/);
  assert.match(action, /WHERE status = 'pending'|eq\(reward_abuse_reviews\.status, "pending"\)/);
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
