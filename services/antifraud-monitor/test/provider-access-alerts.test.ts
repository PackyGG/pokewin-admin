import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXMIND_LOW_FUNDS_USD_THRESHOLD,
  MAXMIND_LOW_QUERIES_THRESHOLD,
  maxmindAccessIssue,
  missingProviderCredentials,
  providerFailureAccessIssue,
} from "../src/provider-access-alerts.js";

test("provider failures cover credentials, timeouts, and unexpected responses", () => {
  assert.deepEqual(providerFailureAccessIssue("fingerprint", "http_401"), {
    provider: "fingerprint",
    kind: "invalid_credential",
  });
  assert.deepEqual(providerFailureAccessIssue("maxmind", "Error:http_402"), {
    provider: "maxmind",
    kind: "quota_exhausted",
  });
  assert.deepEqual(providerFailureAccessIssue("abstract_ip", "credential_expired"), {
    provider: "abstract_ip",
    kind: "expired_credential",
  });
  assert.deepEqual(providerFailureAccessIssue("proxycheck", "TimeoutError"), {
    provider: "proxycheck",
    kind: "timeout",
  });
  assert.deepEqual(providerFailureAccessIssue("proxycheck", "http_500"), {
    provider: "proxycheck",
    kind: "request_failed",
  });
  assert.equal(
    providerFailureAccessIssue("proxycheck", "missing_ip"),
    undefined,
  );
});

test("MaxMind balance metadata raises exhausted and proactive low-credit issues", () => {
  assert.deepEqual(maxmindAccessIssue({
    queries_remaining: 0,
    funds_remaining: 0,
  }), {
    provider: "maxmind",
    kind: "quota_exhausted",
    queriesRemaining: 0,
    fundsRemainingUsd: 0,
  });
  assert.deepEqual(maxmindAccessIssue({
    queries_remaining: MAXMIND_LOW_QUERIES_THRESHOLD,
    funds_remaining: MAXMIND_LOW_FUNDS_USD_THRESHOLD,
  }), {
    provider: "maxmind",
    kind: "quota_low",
    queriesRemaining: MAXMIND_LOW_QUERIES_THRESHOLD,
    fundsRemainingUsd: MAXMIND_LOW_FUNDS_USD_THRESHOLD,
  });
  assert.equal(maxmindAccessIssue({
    queries_remaining: MAXMIND_LOW_QUERIES_THRESHOLD + 1,
    funds_remaining: MAXMIND_LOW_FUNDS_USD_THRESHOLD + 0.01,
  }), undefined);
});

test("bootstrap credential scan reports provider names without secret values", () => {
  const issues = missingProviderCredentials({
    FINGERPRINT_SECRET_API_KEY: "fingerprint-secret",
    PROXYCHECK_API_KEY: "",
    ABSTRACT_IP_INTELLIGENCE_API_KEY: "abstract-ip-secret",
    ABSTRACT_EMAIL_REPUTATION_API_KEY: "abstract-email-secret",
    MAXMIND_ACCOUNT_ID: "123",
    MAXMIND_LICENSE_KEY: "maxmind-secret",
  });
  assert.deepEqual(issues, [{ provider: "proxycheck", kind: "missing_credential" }]);
  assert.doesNotMatch(JSON.stringify(issues), /secret/);
});
