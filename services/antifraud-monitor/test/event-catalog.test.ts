import assert from "node:assert/strict";
import test from "node:test";

import { serviceRequestAuthorized } from "../src/auth.js";
import {
  isDocumentedMonitorEvent,
  isLiveMonitorEvent,
  MONITOR_EVENT_CATALOG,
  unavailableMonitorEvents,
} from "../src/event-catalog.js";
import { ruleCreateSchema } from "../src/request-schemas.js";

test("event catalog keys are unique and separate live from planned events", () => {
  const keys = MONITOR_EVENT_CATALOG.map((event) => event.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(isLiveMonitorEvent("account_signed_up"), true);
  assert.equal(isLiveMonitorEvent("paid_pack_opened"), true);
  assert.equal(isLiveMonitorEvent("ledger_rakeback_claim"), true);
  assert.equal(isDocumentedMonitorEvent("chat_message_sent"), true);
  assert.equal(isLiveMonitorEvent("chat_message_sent"), false);
  assert.deepEqual(
    unavailableMonitorEvents([
      "paid_pack_opened",
      "chat_message_sent",
      "chat_message_sent",
      "not_documented",
    ]),
    ["chat_message_sent", "not_documented"],
  );
});

test("custom flow create contract accepts complete ordered flows", () => {
  const parsed = ruleCreateSchema.parse({
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    actorId: "admin-1",
    name: "Signup reward rush",
    description: "Signup then two rewards",
    enabled: true,
    sequence: ["account_signed_up", "reward_opened", "reward_opened"],
    excludeBefore: ["fiat_deposit", "crypto_deposit"],
    windowSeconds: 180,
    scoreDelta: 35,
    actionType: "manual_review",
  });
  assert.deepEqual(parsed.sequence, [
    "account_signed_up",
    "reward_opened",
    "reward_opened",
  ]);
  assert.equal(parsed.enabled, true);
});

test("rule creation requires the admin service token", () => {
  const config = {
    API_TOKEN: "read-token",
    API_ADMIN_TOKEN: "admin-token",
  };
  assert.equal(
    serviceRequestAuthorized("POST", "/v1/rules", config.API_TOKEN, config),
    false,
  );
  assert.equal(
    serviceRequestAuthorized(
      "POST",
      "/v1/rules",
      config.API_ADMIN_TOKEN,
      config,
    ),
    true,
  );
});
