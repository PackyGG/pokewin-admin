import assert from "node:assert/strict";
import test from "node:test";

import type { EnrichmentResult } from "../src/enrichment.js";
import {
  classifySignupFailure,
  providerSignupFailureKind,
  signupRetryDelaySeconds,
  signupRetryPolicy,
  SignupRecoveryError,
} from "../src/signup-recovery-policy.js";

function failedProvider(
  failureKind: EnrichmentResult["failureKind"],
  errorCode = "provider_error",
): EnrichmentResult {
  return {
    provider: "proxycheck",
    status: "failed",
    lookupKey: "lookup",
    completeness: "unknown",
    providerModel: "test",
    providerVersion: "test",
    provenance: {
      endpoint: "test",
      method: "GET",
      source: "live",
      independent: true,
    },
    failureKind,
    errorCode,
    signals: [],
  };
}

test("provider failures separate transient outages from operator configuration", () => {
  assert.equal(
    providerSignupFailureKind([failedProvider("timeout", "TimeoutError")]),
    "provider_transient",
  );
  assert.equal(
    providerSignupFailureKind([failedProvider("authentication", "http_401")]),
    "provider_configuration",
  );
  assert.equal(
    providerSignupFailureKind([failedProvider("unknown", "http_402")]),
    "provider_configuration",
  );
});

test("retry policies use capped exponential backoff and stop at their budget", () => {
  assert.deepEqual(signupRetryPolicy("provider_transient"), {
    maxAttempts: 8,
    baseDelaySeconds: 60,
    maxDelaySeconds: 3_600,
  });
  assert.equal(signupRetryDelaySeconds("provider_transient", 1), 60);
  assert.equal(signupRetryDelaySeconds("provider_transient", 7), 3_600);
  assert.equal(signupRetryDelaySeconds("provider_transient", 8), null);

  assert.equal(signupRetryDelaySeconds("transient", 1), 60);
  assert.equal(signupRetryDelaySeconds("transient", 4), 480);
  assert.equal(signupRetryDelaySeconds("transient", 5), null);
  assert.equal(signupRetryDelaySeconds("provider_configuration", 1), null);
  assert.equal(signupRetryDelaySeconds("invalid_payload", 1), null);
});

test("generic and explicit recovery errors retain their structured kind", () => {
  const timeout = new Error("request timed out") as Error & { code: string };
  timeout.code = "ETIMEDOUT";
  assert.equal(classifySignupFailure(timeout), "transient");
  assert.equal(
    classifySignupFailure(
      new SignupRecoveryError("provider auth rejected", "provider_configuration"),
    ),
    "provider_configuration",
  );
});
