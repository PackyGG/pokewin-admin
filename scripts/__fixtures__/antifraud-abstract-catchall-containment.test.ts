import assert from "node:assert/strict";
import test from "node:test";

import {
  abstractCatchallContainmentTarget,
  applyAbstractCatchallContainment,
} from "../../src/lib/antifraud/abstract-catchall-containment";
import type { AntifraudSignalEvent } from "../../src/lib/antifraud/ws";

const signal: AntifraudSignalEvent = {
  type: "signal",
  id: "event-1",
  kind: "abstract_email_catchall",
  severity: "high",
  riskScore: 100,
  userId: "user-1",
  username: "player",
  summary: "Catch-all email",
  payload: {
    containmentRequired: true,
    provider: "abstract_email",
    emailDomain: "Example.COM",
  },
  at: "2026-07-30T12:00:00.000Z",
};

test("validated catch-all containment bans the account without mutating KYC", async () => {
  const calls: string[] = [];
  const outcome = await applyAbstractCatchallContainment(signal, {
    banAccount: async (target) => {
      calls.push(`ban:${target.userId}:${target.domain}`);
      return true;
    },
  });

  assert.equal(outcome, "banned");
  assert.deepEqual(calls, ["ban:user-1:example.com"]);
});

test("invalid provider evidence never reaches MAIN", async () => {
  let banCalls = 0;
  const banned = await applyAbstractCatchallContainment(signal, {
    banAccount: async () => {
      banCalls += 1;
      return true;
    },
  });
  assert.equal(banned, "banned");
  assert.equal(banCalls, 1);

  const invalid = {
    ...signal,
    payload: { ...signal.payload, provider: "untrusted" },
  };
  assert.equal(abstractCatchallContainmentTarget(invalid), null);
  assert.equal(
    await applyAbstractCatchallContainment(invalid, {
      banAccount: async () => {
        banCalls += 1;
        return true;
      },
    }),
    "skipped",
  );
  assert.equal(banCalls, 1);
});

test("a missing account is acknowledged without retrying containment", async () => {
  const outcome = await applyAbstractCatchallContainment(signal, {
    banAccount: async () => false,
  });

  assert.equal(outcome, "skipped");
});
