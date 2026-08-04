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
const fraudConfigCard = read(
  "src/app/(antifraud)/antifraud/config/fiat-auto-approval-card.tsx",
);
const fraudAvailabilityCard = read(
  "src/app/(antifraud)/antifraud/config/fiat-availability-card.tsx",
);
const fraudConfigActions = read(
  "src/app/(antifraud)/antifraud/config/fiat-auto-approval-actions.ts",
);
const fraudConfigPage = read(
  "src/app/(antifraud)/antifraud/config/page.tsx",
);
const fraudSidebar = read(
  "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
);
const automation = read(
  "src/app/(antifraud)/antifraud/automation/page.tsx",
);
const automationControls = read(
  "src/app/(antifraud)/antifraud/automation/_sections/controls.tsx",
);
const automationCatalog = read(
  "src/app/(antifraud)/antifraud/automation/automation-catalog.ts",
);
const appHosts = read("src/lib/app-hosts.ts");
const securityLoader = read(
  "src/app/(admin)/security/security-sections-loader.tsx",
);
const securitySections = read(
  "src/app/(admin)/security/security-page-sections.tsx",
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
  assert.match(fraudConfigActions, /requireAntifraudManager\(/);
  assert.match(fraudConfigActions, /fiat_deposit_automatic_credit_updated/);
  assert.match(fraudConfigActions, /revalidatePath\("\/antifraud\/config"\)/);
});

test("global switch confirms the production-impacting policy change", () => {
  assert.match(fraudConfigCard, /<AlertDialog/);
  assert.match(fraudConfigCard, /onCheckedChange=\{setRequestedEnabled\}/);
  assert.match(fraudConfigCard, /Require admin approval for Fiat deposits/);
  assert.match(fraudConfigCard, /per-account auto-approval override/);
  assert.match(fraudConfigCard, /Fraud, KYC, payment-binding/);
});

test("Fraud Config owns both global Fiat controls and hides raw Security config", () => {
  assert.match(fraudConfigPage, /requireAntifraudManagerPage\(\)/);
  assert.match(fraudConfigPage, /getFiatDepositAutomaticCreditConfig\(\)/);
  assert.match(
    fraudConfigPage,
    /initialEnabled=\{config\.fiat_deposit_automatic_credit_enabled\}/,
  );
  assert.match(fraudConfigPage, /GlobalFiatAvailabilityCard/);
  assert.match(fraudAvailabilityCard, /setGlobalFiatDeposits/);
  assert.match(automation, /\{ value: "controls", label: "Controls" \}/);
  assert.match(automation, /tab === "controls" \? \(\s*<AutomationControls \/>/);
  assert.match(automationControls, /href: "\/antifraud\/config"/);
  assert.match(fraudSidebar, /label: "Config", href: "\/antifraud\/config"/);
  assert.match(automationCatalog, /href: "\/antifraud\/config"/);
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"config"/,
  );
  assert.match(securityLoader, /FIAT_DEPOSIT_AUTO_CREDIT_SITE_CONFIG_KEYS/);
  assert.doesNotMatch(securitySections, /Fiat Deposit Approval/);
  assert.doesNotMatch(securityLoader, /fiatAutomaticCredit/);
});
