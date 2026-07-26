import assert from "node:assert/strict";
import test from "node:test";

import { buildDiscordAlertPayload } from "../src/discord.js";

const supportIds = [
  "1302882250391818311",
  "976564661820481606",
  "620373461256110112",
];

const urgentIds = [
  "934854938641715240",
  "660132586630414338",
  "276098533629755392",
  "188051599099297802",
];

test("regular alerts mention only support and include the dashboard button", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Suspicious signup",
      description: "A new case needs review.",
      caseId: "case-123",
    },
  );

  assert.deepEqual(payload.allowed_mentions.users, supportIds);
  assert.equal(payload.username, "PackyGG Fraud");
  assert.equal(payload.content, supportIds.map((id) => `<@${id}>`).join(" "));
  assert.equal(payload.embeds[0]?.color, 0x5865f2);
  assert.equal(
    payload.components[0]?.components[0]?.url,
    "https://fraud.packydash.com/monitor",
  );
});

test("urgent alerts add only the urgent recipients", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "Urgent alert",
      description: "Immediate review required.",
      urgent: true,
    },
  );

  assert.deepEqual(payload.allowed_mentions.users, [
    ...supportIds,
    ...urgentIds,
  ]);
});

test("untrusted alert text cannot create extra mentions", () => {
  const payload = buildDiscordAlertPayload(
    "https://fraud.packydash.com/monitor",
    {
      title: "@everyone <@123456789012345678>",
      description: "@here <@&123456789012345678>",
    },
  );

  assert.equal(payload.embeds[0]?.title, "everyone user 123456789012345678");
  assert.equal(
    payload.embeds[0]?.description,
    "here role 123456789012345678",
  );
  assert.deepEqual(payload.allowed_mentions.users, supportIds);
});
