import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  tierMatchesDeposit,
  validateRewardTiers,
  type RewardTier,
} from "../../src/lib/reward-campaign-tiers";

const tier = (overrides: Partial<RewardTier> = {}): RewardTier => ({
  id: "small",
  label: "$0–$5",
  minDepositUsd: 0,
  maxDepositUsd: 5,
  rewardUsd: 1,
  window: { kind: "rolling", days: 30 },
  ...overrides,
});

test("deposit reward bands are minimum-inclusive and maximum-exclusive", () => {
  assert.equal(tierMatchesDeposit(tier(), 0), true);
  assert.equal(tierMatchesDeposit(tier(), 4.99), true);
  assert.equal(tierMatchesDeposit(tier(), 5), false);
  assert.equal(
    tierMatchesDeposit(tier({ minDepositUsd: 5, maxDepositUsd: null }), 5),
    true,
  );
});

test("tier rules validate rolling and custom timeframes", () => {
  assert.equal(validateRewardTiers([tier()]), null);
  assert.match(
    validateRewardTiers([tier({ window: { kind: "rolling", days: 0 } })]) ?? "",
    /rolling window/,
  );
  assert.match(
    validateRewardTiers([
      tier({
        window: {
          kind: "custom",
          startDate: "2026-08-12",
          endDate: "2026-08-01",
        },
      }),
    ]) ?? "",
    /end date/,
  );
});

test("reward sends preserve tier metadata and reject changed reruns", () => {
  const action = readFileSync(
    "src/app/(admin)/notifications/reward-actions.ts",
    "utf8",
  );
  const audience = readFileSync(
    "src/app/(admin)/notifications/audience-actions.ts",
    "utf8",
  );
  const form = readFileSync(
    "src/app/(admin)/notifications/reward-campaign-form.tsx",
    "utf8",
  );

  assert.match(action, /reward_tier_id/);
  assert.match(action, /already used with different reward settings/);
  assert.match(audience, /lt\.type::text = 'deposit'/);
  assert.match(audience, /first matching tier wins/);
  assert.match(form, /Rolling days/);
  assert.match(form, /Custom dates/);
  assert.match(form, /maximum-exclusive/);
});
