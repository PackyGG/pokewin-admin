import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SIGNUP_REVIEW_SCORE_FLOOR,
  shouldEscalateSignal,
} from "../../src/lib/antifraud/ws";

test("signup score 60 opens Account Review even below the general high band", () => {
  assert.equal(SIGNUP_REVIEW_SCORE_FLOOR, 60);
  assert.equal(
    shouldEscalateSignal({
      kind: "high_risk_signup",
      riskScore: 60,
      severity: "medium",
    }),
    true,
  );
  assert.equal(
    shouldEscalateSignal({
      kind: "high_risk_signup",
      riskScore: 59,
      severity: "medium",
    }),
    false,
  );
});

test("Account Review exposes confirmed no-2FA quick actions", async () => {
  const component = await readFile(
    new URL(
      "../../src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const actions = await readFile(
    new URL(
      "../../src/app/(antifraud)/antifraud/reviews/actions.ts",
      import.meta.url,
    ),
    "utf8",
  );

  for (const action of ["fine", "ban", "lock_withdrawals"]) {
    assert.match(component, new RegExp(`action: "${action}"`));
  }
  assert.match(component, /AlertDialog/);
  assert.match(component, /There is no\s+separate 2FA prompt/);
  assert.match(actions, /runQuickReviewAccountAction/);
  assert.match(actions, /__can_ban_users/);
  assert.match(actions, /__can_toggle_feature_locks/);
  assert.doesNotMatch(actions, /require2FA/);
});
