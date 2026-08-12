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

test("behavioral rule matches always open Account Review", () => {
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "behavioral_rule_match",
      riskScore: 20,
      severity: "low",
    }),
    true,
  );
});

test("dormant device switches are context-only review evidence", async () => {
  assert.equal(
    shouldOpenReviewForSignal({
      kind: "dormant_device_switch",
      riskScore: 60,
      severity: "high",
    }),
    false,
  );

  const ingest = await readFile(
    new URL("../../src/app/api/antifraud/ingest/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(ingest, /shouldAttachToLiveCase/);
  assert.match(ingest, /else if \(shouldOpenCase\)/);
});

test("Fraud review surfaces do not expose escalation controls", async () => {
  const files = await Promise.all(
    [
      "../../src/lib/antifraud/constants.ts",
      "../../src/app/(antifraud)/antifraud/reviews/_components/quick-review-actions.tsx",
      "../../src/app/(antifraud)/antifraud/fiat-deposits/review-decision.tsx",
      "../../src/app/(antifraud)/antifraud/flows/flow-builder.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  for (const source of files) {
    assert.doesNotMatch(source, /\bEscalat(?:e|ed|ion)\b/i);
  }
});

test("Account Review's status-changing quick actions are only approve, ban, and postpone", async () => {
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

test("Account Review can require KYC without changing the case status", async () => {
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

  // The dialog reuses the KYC workspace's own gated action instead of
  // duplicating the KYC-triggering logic.
  assert.match(component, /<RequireKycButton/);
  assert.match(component, /requireReviewKyc/);
  assert.match(actions, /export async function requireReviewKyc/);
  assert.match(actions, /requireAccountKyc\(\{/);
  assert.match(actions, /from "\.\.\/kyc\/actions"/);
  assert.match(actions, /account_review_kyc_required/);

  // Additive, not a verdict: requireReviewKyc must never touch the review's
  // status the way updateReviewStatus / runQuickReviewAccountAction do.
  const requireKycBody = actions.slice(
    actions.indexOf("export async function requireReviewKyc"),
    actions.indexOf("const assignSchema"),
  );
  assert.doesNotMatch(requireKycBody, /status:\s*"(open|in_review|cleared|flagged)"/);
  assert.doesNotMatch(requireKycBody, /antifraud_reviews\)\s*\.set\(/);
});
