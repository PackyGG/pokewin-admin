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

test("validated catch-all containment locks the account and requires KYC", async () => {
  const calls: string[] = [];
  const outcome = await applyAbstractCatchallContainment(signal, {
    lockAccount: async (target) => {
      calls.push(`lock:${target.userId}:${target.domain}`);
      return true;
    },
    isKycRequired: async (userId) => {
      calls.push(`kyc-status:${userId}`);
      return false;
    },
    requireKyc: async (target) => {
      calls.push(`require-kyc:${target.userId}`);
    },
  });

  assert.equal(outcome, "locked");
  assert.deepEqual(calls, [
    "lock:user-1:example.com",
    "kyc-status:user-1",
    "require-kyc:user-1",
  ]);
});

test("existing KYC is preserved and invalid provider evidence never reaches MAIN", async () => {
  let lockCalls = 0;
  let kycCalls = 0;
  const alreadyRequired = await applyAbstractCatchallContainment(signal, {
    lockAccount: async () => {
      lockCalls += 1;
      return true;
    },
    isKycRequired: async () => true,
    requireKyc: async () => {
      kycCalls += 1;
    },
  });
  assert.equal(alreadyRequired, "locked");
  assert.equal(lockCalls, 1);
  assert.equal(kycCalls, 0);

  const invalid = {
    ...signal,
    payload: { ...signal.payload, provider: "untrusted" },
  };
  assert.equal(abstractCatchallContainmentTarget(invalid), null);
  assert.equal(
    await applyAbstractCatchallContainment(invalid, {
      lockAccount: async () => {
        lockCalls += 1;
        return true;
      },
      isKycRequired: async () => false,
      requireKyc: async () => {
        kycCalls += 1;
      },
    }),
    "skipped",
  );
  assert.equal(lockCalls, 1);
  assert.equal(kycCalls, 0);
});

test("a missing account is acknowledged without starting KYC", async () => {
  let kycRead = false;
  const outcome = await applyAbstractCatchallContainment(signal, {
    lockAccount: async () => false,
    isKycRequired: async () => {
      kycRead = true;
      return false;
    },
    requireKyc: async () => {
      throw new Error("must not run");
    },
  });

  assert.equal(outcome, "skipped");
  assert.equal(kycRead, false);
});
