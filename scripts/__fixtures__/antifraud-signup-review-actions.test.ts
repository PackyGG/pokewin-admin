import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SIGNUP_REVIEW_SCORE_FLOOR,
  shouldOpenReviewForSignal,
} from "../../src/lib/antifraud/ws";

test("signup score 50 opens Account Review at the high-risk floor", () => {
  assert.equal(SIGNUP_REVIEW_SCORE_FLOOR, 50);
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "high_risk_signup",
      riskScore: 50,
      severity: "high",
    }),
    true,
  );
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "high_risk_signup",
      riskScore: 49,
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
      "../../src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
      "../../src/app/(antifraud)/antifraud/fiat-deposits/[id]/review-controls.tsx",
      "../../src/app/(antifraud)/antifraud/flows/flow-builder.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  for (const source of files) {
    assert.doesNotMatch(source, /\bEscalat(?:e|ed|ion)\b/i);
  }
});

test("Account Review exposes only approve, ban, and postpone", async () => {
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

  for (const action of ["fine", "ban"]) {
    assert.match(component, new RegExp(`action: "${action}"`));
  }
  assert.doesNotMatch(component, /action: "lock_withdrawals"/);
  assert.match(component, /<PostponeButton/);
  assert.match(component, /AlertDialog/);
  assert.match(component, /StepUpField/);
  assert.match(component, /sensitive = action === "ban"/);
  assert.match(component, /<PostponeButton/);
  assert.doesNotMatch(component, /action: "lock_withdrawals"/);
  assert.match(actions, /runQuickReviewAccountAction/);
  assert.match(actions, /__can_ban_users/);
  assert.match(actions, /require2FA\(session\.userId, parsed\.data\.credential\)/);
});
