import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

const featureApi = read("src/lib/backend-api/feature-locks.ts");
const rewardLockContract = read("src/lib/contracts/reward-locks.ts");
const accountCard = read(
  "src/app/(admin)/users/[id]/reward-feature-locks-card.tsx",
);
const accountActions = read(
  "src/app/(admin)/users/[id]/reward-feature-locks-actions.ts",
);
const accountTab = read(
  "src/app/(admin)/users/[id]/user-view-modern-tabs.tsx",
);
const fiatConfigApi = read("src/lib/backend-api/fiat-deposit-review.ts");
const securityCard = read(
  "src/app/(admin)/security/fiat-auto-approval-card.tsx",
);
const securityActions = read(
  "src/app/(admin)/security/fiat-auto-approval-actions.ts",
);
const securityLoader = read(
  "src/app/(admin)/security/security-sections-loader.tsx",
);

test("reward feature locks mirror every backend category", () => {
  for (const category of [
    "tips",
    "rain",
    "daily_packs",
    "sponsored_battles",
    "rakeback",
    "leaderboards",
  ]) {
    assert.match(rewardLockContract, new RegExp(`"${category}"`));
  }
  assert.match(featureApi, /locked_reward_categories/);
  assert.match(featureApi, /available_reward_categories/);
  assert.match(featureApi, /\/rewards-lock/);
  assert.match(featureApi, /FeatureLocksResponseSchema\.safeParse/);
});

test("Account Feature Locks contains master, granular, and Fiat override controls", () => {
  assert.match(accountTab, /title="Feature Locks"/);
  assert.match(accountTab, /<RewardFeatureLocksStreamed/);
  assert.match(accountCard, /Whole rewards lock/);
  assert.match(accountCard, /Leaderboards & races/);
  assert.match(accountCard, /Fiat deposit auto-approval override/);
  assert.match(accountCard, /\[\.\.\.REWARD_LOCK_CATEGORIES\]/);
  assert.match(accountCard, /categories\.filter/);
});

test("reward locks use the narrow capability while Fiat override stays admin-only", () => {
  assert.match(accountActions, /requirePageAccess\("\/users"\)/);
  assert.match(accountActions, /__can_toggle_feature_locks/);
  assert.match(accountActions, /const session = await requireAdmin\(\)/);
  assert.match(accountActions, /user_reward_locks_updated/);
  assert.match(accountActions, /user_fiat_auto_approval_updated/);
  assert.match(accountActions, /revalidateTag\(`users-detail-/);
});

test("global Fiat switch uses the backend-owned automatic-credit contract", () => {
  assert.match(fiatConfigApi, /fiat_deposit_automatic_credit_enabled/);
  assert.match(fiatConfigApi, /\/admin\/fiat-deposits\/config/);
  assert.match(fiatConfigApi, /ResponseSchema\.safeParse/);
  assert.match(securityActions, /requirePageAccess\("\/security"\)/);
  assert.match(securityActions, /requireAdmin\(\)/);
  assert.match(securityActions, /fiat_deposit_automatic_credit_updated/);
  assert.match(securityActions, /revalidateTag\(SECURITY_CACHE_TAG\)/);
});

test("global switch confirms the production-impacting policy change", () => {
  assert.match(securityCard, /<AlertDialog/);
  assert.match(securityCard, /onCheckedChange=\{setRequestedEnabled\}/);
  assert.match(securityCard, /Require admin approval for Fiat deposits/);
  assert.match(securityCard, /per-account auto-approval override/);
  assert.match(securityCard, /Fraud, KYC, payment-binding/);
});

test("dedicated Fiat switch is cached and hidden from raw site config", () => {
  assert.match(
    securityLoader,
    /getCachedFiatDepositAutomaticCreditConfig\(\)/,
  );
  assert.match(securityLoader, /FIAT_AUTO_APPROVAL_SITE_CONFIG_KEYS/);
  assert.match(securityLoader, /fiatAutomaticCredit=/);
});
