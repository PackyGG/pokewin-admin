import assert from "node:assert/strict";
import test from "node:test";

import { buildDiscordAlertPayload } from "../src/discord.js";

// This service no longer decides who is tagged, so it no longer carries a copy
// of the recipient ids. Mention text and its `allowed_mentions` allowlist are
// built per destination channel by `enqueueDiscordEvent` in the admin app.

test("regular alerts do not escalate and include the dashboard button", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Suspicious signup",
      description: "A new case needs review.",
    },
  );

  assert.equal(payload.escalate, false);
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

test("high-risk signup alerts show structured evidence and link to the case", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "High-risk signup detected",
      description:
        "This account crossed the automated signup review threshold.",
      username: "review_me",
      userId: "user-123",
      caseId: "case-123",
      score: 60,
      severity: "medium",
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
  assert.equal(payload.embeds[0]?.color, 0xf59e0b);
  assert.equal(
    payload.embeds[0]?.url,
    "https://fraud.packydash.com/reviews?monitorCaseId=case-123",
  );
  assert.equal(payload.components[0]?.components[0]?.label, "Review case");
  assert.equal(
    payload.components[0]?.components[0]?.url,
    "https://fraud.packydash.com/reviews?monitorCaseId=case-123",
  );
  assert.match(
    fields.find((field) => field.name === "Account")?.value ?? "",
    /\*\*review\\_me\*\*\nUser ID `user-123`/,
  );
  assert.equal(
    fields.find((field) => field.name === "Risk score")?.value,
    "**60 points**\nMedium risk",
  );
  assert.match(
    fields.find((field) => field.name === "Why it was flagged")?.value ?? "",
    /\*\*\+60 \| Shared device\*\*[\s\S]*\*\*-20 \| Irreversible deposit\*\*/,
  );
  assert.equal(
    fields.find((field) => field.name === "Case ID")?.value,
    "`case-123`",
  );
});

test("risk accents follow the score severity", () => {
  const high = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "High",
      description: "High risk",
      score: 80,
      severity: "high",
    },
  );
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

test("urgent alerts ask the queue to add the escalation groups", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Urgent alert",
      description: "Immediate review required.",
      urgent: true,
    },
  );

  assert.equal(payload.escalate, true);
});

test("untrusted alert text cannot create extra mentions", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "@everyone <@123456789012345678>",
      description: "@here <@&123456789012345678>",
    },
  );

  assert.equal(
    payload.embeds[0]?.title,
    "🛡️ everyone user 123456789012345678",
  );
  assert.equal(
    payload.embeds[0]?.description,
    "here role 123456789012345678",
  );
  assert.equal(payload.escalate, false);
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

  assert.ok((payload.embeds[0]?.description.length ?? 0) <= 1_200);
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
  assert.equal(payload.escalate, false);
});
