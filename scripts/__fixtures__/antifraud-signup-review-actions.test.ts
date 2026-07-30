import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SIGNUP_REVIEW_SCORE_FLOOR,
  shouldOpenReviewForSignal,
} from "../../src/lib/antifraud/ws";

test("signup score 60 opens Account Review even below the general high band", () => {
  assert.equal(SIGNUP_REVIEW_SCORE_FLOOR, 60);
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "high_risk_signup",
      riskScore: 60,
      severity: "medium",
    }),
    true,
  );
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "high_risk_signup",
      riskScore: 59,
      severity: "medium",
    }),
    false,
  );
});

test("Abstract catch-all signals always open Account Review", () => {
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "abstract_email_catchall",
      riskScore: 0,
      severity: "low",
    }),
    true,
  );
});

test("Fraud review surfaces do not expose escalation controls", async () => {
  const files = await Promise.all(
    [
      "../../src/lib/antifraud/constants.ts",
      "../../src/app/(antifraud)/antifraud/reviews/_components/case-controls.tsx",
      "../../src/app/(antifraud)/antifraud/monitor/cases/[id]/_components/decision-panel.tsx",
      "../../src/app/(antifraud)/antifraud/fiat-deposits/[id]/review-controls.tsx",
      "../../src/app/(antifraud)/antifraud/withdrawals/[id]/review-controls.tsx",
      "../../src/app/(antifraud)/antifraud/flows/flow-builder.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  for (const source of files) {
    assert.doesNotMatch(source, /\bEscalat(?:e|ed|ion)\b/i);
  }
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
