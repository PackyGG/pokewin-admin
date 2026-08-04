import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildReviewReminderMessage,
  REVIEW_REMINDER_FIELD_NAMES,
} from "../../src/lib/discord-notifications/review-reminder-card.ts";

test("review reminder uses the compact high-risk card and review button", () => {
  const message = buildReviewReminderMessage(
    {
      reviewId: "6f62e77c-b7eb-4ec0-94dc-911ff8fc665c",
      targetUserId: "user-123",
      targetUsername: "review_me",
      staffAction: "claimed",
      staffUsername: "fraud_agent",
    },
    "correlation-123",
  );

  assert.equal(message.embed.title, "\u26A0\uFE0F Account review reminder");
  assert.equal(message.embed.color, 0xf97316);
  assert.equal("description" in message.embed, false);
  assert.deepEqual(
    message.embed.fields.map((field) => field.name),
    [
      REVIEW_REMINDER_FIELD_NAMES.username,
      REVIEW_REMINDER_FIELD_NAMES.userId,
      REVIEW_REMINDER_FIELD_NAMES.caseId,
      REVIEW_REMINDER_FIELD_NAMES.claimedBy,
    ],
  );
  assert.deepEqual(
    message.embed.fields.map((field) => field.value),
    [
      "review\\_me",
      "`user-123`",
      "`6f62e77c-b7eb-4ec0-94dc-911ff8fc665c`",
      "fraud\\_agent",
    ],
  );
  assert.equal(message.components[0]?.components[0]?.label, "Open Account Review");
  assert.equal(
    message.components[0]?.components[0]?.url,
    "https://fraud.packydash.com/reviews?review=6f62e77c-b7eb-4ec0-94dc-911ff8fc665c",
  );
  assert.doesNotMatch(JSON.stringify(message), /Queue|Reason|still unresolved/);
});

test("unclaimed reminders identify who started the case", () => {
  const message = buildReviewReminderMessage(
    {
      reviewId: "case-123",
      targetUserId: "user-123",
      targetUsername: null,
      staffAction: "started",
      staffUsername: "System",
    },
    "correlation-123",
  );

  assert.equal(message.embed.fields[0]?.value, "Unknown");
  assert.equal(
    message.embed.fields[3]?.name,
    REVIEW_REMINDER_FIELD_NAMES.startedBy,
  );
  assert.equal(message.embed.fields[3]?.value, "System");
});

test("reminder query resolves claimed and started staff usernames", () => {
  const source = readFileSync(
    "src/lib/discord-notifications/review-reminders.ts",
    "utf8",
  );

  assert.match(source, /assignee\.username AS assigned_staff_username/);
  assert.match(source, /opener\.username AS opened_staff_username/);
  assert.match(source, /LEFT JOIN admin_users AS assignee/);
  assert.match(source, /LEFT JOIN admin_users AS opener/);
  assert.doesNotMatch(source, /review\.reason/);
});
