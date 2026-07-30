import assert from "node:assert/strict";
import test from "node:test";

import { providerContractMetadata } from "../src/enrichment.js";
import { persistProviderEvidence } from "../src/profile-store.js";

test("provider evidence is append-only per stable assessment occurrence", async () => {
  const writes: unknown[][] = [];
  const db = {
    async query(_sql: string, values?: unknown[]) {
      writes.push(values ?? []);
      return { rows: [], rowCount: 1 };
    },
  };
  const result = {
    provider: "proxycheck" as const,
    status: "success" as const,
    lookupKey: "192.0.2.1",
    score: 25,
    ...providerContractMetadata("proxycheck", "live", "complete", {
      nativeScore: 25,
      nativeRank: "proxy",
      nativeConfidence: 96,
    }),
    response: { proxy: true },
    signals: [
      {
        key: "proxycheck_anonymous_lower_risk",
        title: "Proxy",
        detail: "Provider-confirmed proxy.",
        points: 25,
      },
    ],
  };

  await persistProviderEvidence(db, "user-1", result, "assessment:one");
  await persistProviderEvidence(db, "user-1", result, "assessment:two");
  await persistProviderEvidence(db, "user-1", result, "assessment:one");

  assert.equal(writes.length, 3);
  assert.notEqual(writes[0]?.[3], writes[1]?.[3]);
  assert.equal(writes[0]?.[3], writes[2]?.[3]);
  assert.equal(writes[0]?.[7], "complete");
  assert.deepEqual(JSON.parse(String(writes[0]?.[8])), { proxy: true });
  assert.equal(writes[0]?.[11], "ProxyCheck v3 Pro");
  assert.equal(writes[0]?.[12], "24-June-2026");
  assert.equal(writes[0]?.[13], 25);
  assert.equal(writes[0]?.[14], "proxy");
  assert.equal(writes[0]?.[15], 96);
  assert.deepEqual(JSON.parse(String(writes[0]?.[16])), {
    endpoint: "/v3/{ip}",
    method: "GET",
    source: "live",
    independent: true,
  });
});

test("a recovered provider check appends success after failure", async () => {
  const writes: unknown[][] = [];
  const db = {
    async query(_sql: string, values?: unknown[]) {
      writes.push(values ?? []);
      return { rows: [], rowCount: 1 };
    },
  };
  const failed = {
    provider: "proxycheck" as const,
    status: "failed" as const,
    lookupKey: "192.0.2.1",
    errorCode: "http_429",
    ...providerContractMetadata("proxycheck", "live", "unknown", {
      errorCode: "http_429",
    }),
    signals: [],
  };
  const recovered = {
    provider: "proxycheck" as const,
    status: "success" as const,
    lookupKey: "192.0.2.1",
    score: 5,
    ...providerContractMetadata("proxycheck", "live", "complete", {
      nativeScore: 5,
    }),
    response: { risk: 5 },
    signals: [],
  };

  await persistProviderEvidence(db, "user-1", failed, "assessment:one");
  await persistProviderEvidence(db, "user-1", recovered, "assessment:one");
  await persistProviderEvidence(db, "user-1", recovered, "assessment:one");

  assert.notEqual(writes[0]?.[3], writes[1]?.[3]);
  assert.equal(writes[1]?.[3], writes[2]?.[3]);
  assert.equal(writes[0]?.[6], "rate_limited");
  assert.equal(writes[1]?.[5], "success");
});
