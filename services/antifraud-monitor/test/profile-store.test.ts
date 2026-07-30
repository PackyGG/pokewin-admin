import assert from "node:assert/strict";
import test from "node:test";

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
  assert.deepEqual(JSON.parse(String(writes[0]?.[7])), { proxy: true });
});
