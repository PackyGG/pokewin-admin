import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiscordAlertPayload,
  SIGNUP_RISK_FIELD_NAMES,
} from "../src/discord.js";

// This service no longer decides who is tagged, so it no longer carries a copy
// of the recipient ids. Mention text and its `allowed_mentions` allowlist are
// built per destination channel by `enqueueDiscordEvent` in the admin app.

test("regular alerts include the dashboard button without recipient input", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Suspicious signup",
      description: "A new case needs review.",
    },
  );

  assert.ok(!("escalate" in payload));
  assert.equal(payload.username, "PackyGG Fraud");
  // No content and no allowed_mentions: both used to be built here and then
  // silently dropped before the payload ever reached Discord.
  assert.ok(!("content" in payload));
  assert.ok(!("allowed_mentions" in payload));
  assert.equal(payload.embeds[0]?.color, 0x5865f2);
  assert.equal(
    payload.components[0]?.components[0]?.url,
    "https://fraud.packydash.com/monitor",
  );
  assert.equal(payload.components[0]?.components[0]?.label, "Open Antifraud");
});

test("high-risk signup alerts show a clean account and evidence summary", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "High-risk signup detected",
      description: "Review the account indicators and current locks below.",
      presentation: "signup-risk",
      username: "review_me",
      userId: "user-123",
      location: { city: "Berlin", country: "Germany", countryCode: "DE" },
      locks: [],
      caseId: "case-123",
      score: 60,
      severity: "high",
      occurredAt: new Date("2026-08-04T21:30:00.000Z"),
      trigger: "Signup score reached 60+",
      signals: [
        {
          title: "Shared device",
          detail: "Three accounts share this device.",
          points: 60,
        },
        {
          title: "Irreversible deposit",
          detail: "A settled crypto deposit reduces the risk score.",
          points: -20,
        },
      ],
    },
  );

  const fields = payload.embeds[0]?.fields ?? [];
  assert.equal(payload.embeds[0]?.color, 0xf97316);
  assert.equal("description" in (payload.embeds[0] ?? {}), false);
  assert.equal(
    payload.embeds[0]?.url,
    "https://fraud.packydash.com/monitor/cases/case-123",
  );
  assert.equal(
    payload.components[0]?.components[0]?.label,
    "Open Account Review",
  );
  assert.equal(
    payload.components[0]?.components[0]?.url,
    "https://fraud.packydash.com/monitor/cases/case-123",
  );
  assert.match(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.username)
      ?.value ?? "",
    /^review\\_me$/,
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.userId)
      ?.value,
    "`user-123`",
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.riskScore)
      ?.value,
    "**60 points**",
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.location)
      ?.value,
    "Berlin, Germany \\(DE\\)",
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.locks)?.value,
    "None",
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.time)?.value,
    "<t:1785879000:F>",
  );
  assert.match(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.reasons)
      ?.value ?? "",
    /\*\*\+60 points\*\* \u00b7 Shared device[\s\S]*\*\*-20 points\*\* \u00b7 Irreversible deposit/,
  );
  assert.equal(
    fields.some((field) => field.name === "Trigger"),
    false,
  );
  assert.equal(
    fields.some((field) => field.name === "Case ID"),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(payload),
    /Three accounts share this device/,
  );
});

test("critical signup alerts list every automatic lock", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Critical-risk signup",
      description: "Review the account indicators and current locks below.",
      presentation: "signup-risk",
      username: "critical_user",
      userId: "user-critical",
      location: { countryCode: "NL" },
      locks: [
        "Fiat deposits",
        "Crypto withdrawals",
        "Item withdrawals",
        "Tips",
      ],
      caseId: "case-critical",
      score: 92,
      severity: "critical",
      signals: [
        { title: "Disposable email", detail: "Hidden detail", points: 40 },
      ],
    },
  );

  const fields = payload.embeds[0]?.fields ?? [];
  assert.equal("description" in (payload.embeds[0] ?? {}), false);
  assert.match(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.locks)
      ?.value ?? "",
    /^Fiat deposits \u{00B7} Crypto withdrawals \u{00B7} Item withdrawals \u{00B7} Tips$/u,
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.location)
      ?.value,
    "NL",
  );
  assert.equal(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.riskScore)
      ?.value,
    "**92 points**",
  );
  assert.doesNotMatch(
    fields.find((field) => field.name === SIGNUP_RISK_FIELD_NAMES.riskScore)
      ?.value ?? "",
    /Critical risk/,
  );
  assert.equal(
    fields.some((field) => field.name === "Case ID"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(payload), /Hidden detail/);
});

test("risk accents follow the score severity", () => {
  const high = buildDiscordAlertPayload("https://fraud.packydash.com/monitor", {
    title: "High",
    description: "High risk",
    score: 80,
    severity: "high",
  });
  const critical = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Critical",
      description: "Critical risk",
      score: 120,
      severity: "critical",
    },
  );

  assert.equal(high.embeds[0]?.color, 0xf97316);
  assert.equal(critical.embeds[0]?.color, 0xed4245);
});

test("rule alerts show the score change and review outcome", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Rule matched: Reward rush",
      description: "A monitored account matched an antifraud rule.",
      score: 95,
      scoreDelta: 35,
      severity: "high",
      trigger: "reward_rush",
      outcome: "manual_review",
    },
  );
  const fields = payload.embeds[0]?.fields ?? [];

  assert.equal(
    fields.find((field) => field.name === "Score change")?.value,
    "**+35 points**",
  );
  assert.equal(
    fields.find((field) => field.name === "Outcome")?.value,
    "Manual review",
  );
});

test("urgent alerts change presentation without changing recipients", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Urgent alert",
      description: "Immediate review required.",
      urgent: true,
    },
  );

  assert.ok(!("escalate" in payload));
  assert.equal(payload.embeds[0]?.color, 0xed4245);
  assert.match(payload.embeds[0]?.footer.text ?? "", /URGENT/);
});

test("untrusted alert text cannot create extra mentions", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "@everyone <@123456789012345678>",
      description: "@here <@&123456789012345678>",
    },
  );

  assert.equal(payload.embeds[0]?.title, "🛡️ everyone user 123456789012345678");
  assert.equal(payload.embeds[0]?.description, "here role 123456789012345678");
  assert.ok(!("escalate" in payload));
});

test("long evidence stays inside Discord field limits", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Bounded evidence",
      description: "A".repeat(5_000),
      trigger: "_".repeat(2_000),
      signals: Array.from({ length: 8 }, (_, index) => ({
        title: `Signal ${index}`,
        detail: "D".repeat(700),
        points: 100 - index,
      })),
    },
  );

  assert.ok((payload.embeds[0]?.description?.length ?? 0) <= 1_200);
  for (const field of payload.embeds[0]?.fields ?? []) {
    assert.ok(field.value.length <= 1_024);
  }
  assert.match(
    payload.embeds[0]?.fields.find(
      (field) => field.name === "Why it was flagged",
    )?.value ?? "",
    /more signals in the case/,
  );
});

test("an alert can link directly to Account Review", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Automatic fiat withdrawal hold",
      description: "The account needs review.",
      url: "https://fraud.packydash.com/antifraud/reviews",
    },
  );

  assert.equal(
    payload.components[0]?.components[0]?.url,
    "https://fraud.packydash.com/antifraud/reviews",
  );
  assert.ok(!("escalate" in payload));
});
