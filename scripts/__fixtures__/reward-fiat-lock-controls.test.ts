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
const fraudAccessCard = read(
  "src/app/(antifraud)/antifraud/config/fiat-deposit-access-control-card.tsx",
);
const fraudAccessActions = read(
  "src/app/(antifraud)/antifraud/config/fiat-deposit-access-control-actions.ts",
);
const fraudAccessControl = read(
  "services/antifraud-monitor/src/fiat-deposit-access-control.ts",
);
const defaultSignupAccessMigration = read(
  "services/antifraud-monitor/migrations/056_default_new_signup_fiat_access_off.sql",
);
const fraudConfigPage = read(
  "src/app/(antifraud)/antifraud/config/page.tsx",
);
const fraudSidebar = read(
  "src/app/(antifraud)/antifraud/_components/antifraud-sidebar.tsx",
);
const settingsPage = read(
  "src/app/(antifraud)/antifraud/settings/page.tsx",
);
const automationCatalog = read(
  "src/app/(antifraud)/antifraud/settings/_lib/automation-catalog.ts",
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

test("combined Account access section contains master, granular, and Fiat override controls", () => {
  assert.match(accountTab, /title="Feature Locks & Fiat Access"/);
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
  assert.match(fraudConfigActions, /createAdminAuditEventDurable/);
  assert.match(fraudConfigActions, /revalidatePath\("\/antifraud\/config"\)/);
});

test("global switch confirms the production-impacting policy change", () => {
  assert.match(fraudConfigCard, /<AlertDialog/);
  assert.match(fraudConfigCard, /onCheckedChange=\{setRequestedEnabled\}/);
  assert.match(fraudConfigCard, /Require admin approval for Fiat deposits/);
  assert.match(fraudConfigCard, /per-account auto-approval override/);
  assert.doesNotMatch(fraudConfigCard, /This controls the credit step only/);
  assert.doesNotMatch(fraudAvailabilityCard, /This is the master availability gate/);
  assert.doesNotMatch(fraudAvailabilityCard, /users still must pass every account/);
  assert.doesNotMatch(fraudConfigCard, /Existing safety checks still apply/);
  assert.match(fraudConfigCard, /<Badge variant="outline">Unavailable<\/Badge>/);
  assert.match(fraudConfigCard, /checked=\{false\}[\s\S]*?disabled/);
  assert.match(fraudConfigCard, /max-w-3xl space-y-2/);
  assert.doesNotMatch(fraudConfigCard, /flex flex-wrap items-start justify-between gap-4/);
  assert.match(fraudAvailabilityCard, /max-w-3xl space-y-2/);
  assert.doesNotMatch(fraudAvailabilityCard, /flex flex-wrap items-start justify-between gap-4/);
});

test("Fraud Config owns all four Fiat controls and hides raw Security config", () => {
  assert.match(fraudConfigPage, /requireAntifraudManagerPage\(\)/);
  assert.match(fraudConfigPage, /getFiatDepositAutomaticCreditConfig/);
  assert.match(fraudConfigPage, /safeQueryOrNull\(/);
  assert.match(fraudConfigPage, /BACKEND_CONFIG_TIMEOUT_MS/);
  assert.match(fraudConfigPage, /result\.data\?\.fiat_deposit_automatic_credit_enabled/);
  assert.doesNotMatch(fraudConfigPage, /redirect\(/);
  assert.match(settingsPage, /\{ value: "automation", label: "Automation" \}/);
  assert.match(fraudConfigPage, /GlobalFiatAvailabilityCard/);
  assert.match(fraudConfigPage, /FiatDepositAccessControlCard/);
  assert.match(fraudAccessCard, /Fiat access for existing accounts/);
  assert.match(fraudAccessCard, /Fiat access for new signups/);
  assert.match(fraudAccessCard, /Fiat allowed for all accounts/);
  assert.match(fraudAccessCard, /Fiat allowed for existing accounts only/);
  assert.match(fraudAccessCard, /Fiat access is turning on/);
  assert.match(fraudAccessCard, /Controller allows/);
  assert.match(fraudAccessCard, /Controller blocks/);
  assert.match(fraudAccessCard, /fiat_deposits_enabled/);
  assert.match(fraudAccessCard, /signup\.generation === 0/);
  assert.match(fraudAccessCard, /Not configured/);
  assert.match(fraudAccessActions, /requireAntifraudManager\(/);
  assert.match(fraudAccessActions, /fiat_deposit_access_policy_updated/);
  assert.match(fraudAccessActions, /createAdminAuditEventDurable/);
  assert.doesNotMatch(fraudAccessCard, /Country, KYC, fraud, payment/);
  assert.doesNotMatch(fraudAvailabilityCard, /updateFiatAccessControl/);
  assert.doesNotMatch(fraudAccessActions, /setGlobalFiatDeposits/);
  assert.match(
    fraudAccessControl,
    /scope = 'existing_accounts'[\s\S]*?VALUES \('existing_accounts'/,
  );
  assert.match(
    fraudAccessControl,
    /scope = 'new_signups'[\s\S]*?VALUES \('new_signups'/,
  );
  assert.match(fraudAccessControl, /created_at < \$3/);
  assert.match(
    defaultSignupAccessMigration,
    /'new_signups'[\s\S]*?false[\s\S]*?'system:default-new-signup-policy'/,
  );
  assert.match(
    defaultSignupAccessMigration,
    /fiat_deposit_access_cursors\(stream, occurred_at, source_id\)/,
  );
  assert.doesNotMatch(defaultSignupAccessMigration, /'existing_accounts'/);
  assert.match(fraudAvailabilityCard, /setGlobalFiatDeposits/);
  assert.match(fraudSidebar, /label: "Config",\s*href: "\/antifraud\/config"/);
  assert.match(automationCatalog, /href: "\/antifraud\/config"/);
  assert.match(
    appHosts,
    /host:\s*`fraud\.\$\{ROOT_DOMAIN\}`[\s\S]*?segmentRoutes:\s*\[[\s\S]*?"config"/,
  );
  assert.match(securityLoader, /FIAT_DEPOSIT_AUTO_CREDIT_SITE_CONFIG_KEYS/);
  assert.doesNotMatch(securitySections, /Fiat Deposit Approval/);
  assert.doesNotMatch(securityLoader, /fiatAutomaticCredit/);
});
