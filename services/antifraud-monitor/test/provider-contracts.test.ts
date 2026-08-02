import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyProviderFailure,
  PROVIDER_CONTRACTS,
} from "../src/provider-contracts.js";

test("signup provider contracts expose only compiled non-secret provenance", () => {
  assert.deepEqual(Object.keys(PROVIDER_CONTRACTS), [
    "fingerprint",
    "proxycheck",
    "abstract_ip",
    "abstract_email",
    "opportify",
    "maxmind",
  ]);
  assert.equal(PROVIDER_CONTRACTS.proxycheck.version, "24-June-2026");
  assert.equal(PROVIDER_CONTRACTS.abstract_email.requiredDatum, "email");
  assert.equal(
    PROVIDER_CONTRACTS.opportify.requiredDatum,
    "email_or_signup_ip",
  );
  assert.equal(PROVIDER_CONTRACTS.maxmind.version, "v2.0");
  const serialized = JSON.stringify(PROVIDER_CONTRACTS);
  assert.doesNotMatch(serialized, /api[_-]?key|token|secret|authorization/i);
});

test("provider failures retain actionable failure kinds", () => {
  assert.equal(classifyProviderFailure("TimeoutError"), "timeout");
  assert.equal(classifyProviderFailure("http_429"), "rate_limited");
  assert.equal(classifyProviderFailure("http_401"), "authentication");
  assert.equal(classifyProviderFailure("invalid_response"), "invalid_response");
  assert.equal(classifyProviderFailure("http_503"), "upstream");
  assert.equal(
    classifyProviderFailure("missing_request_id"),
    "missing_compatible_datum",
  );
  assert.equal(classifyProviderFailure("opaque"), "unknown");
});

test("provider evidence migration preserves the full request contract", () => {
  const migration = readFileSync(
    new URL(
      "../migrations/039_signup_provider_contract_evidence.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const column of [
    "completeness",
    "provider_model",
    "provider_version",
    "native_score",
    "native_rank",
    "native_confidence",
    "provenance",
    "error_code",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migration, /missing_compatible_datum/);
  assert.match(migration, /legacy_provider_checks_backfill/);
});
