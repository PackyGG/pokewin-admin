import assert from "node:assert/strict";
import test from "node:test";

import { providerNetworkAsn } from "../src/signup-campaign.js";
import type { EnrichmentResult } from "../src/enrichment.js";

function result(provider: string, response: Record<string, unknown>): EnrichmentResult {
  return { provider, response } as EnrichmentResult;
}

test("campaign ASN extraction accepts each sanitized provider contract", () => {
  assert.equal(providerNetworkAsn([result("fingerprint", {
    products: { ipInfo: { data: { v4: { asn: { asn: "AS12810" } } } } },
  })]), "12810");
  assert.equal(providerNetworkAsn([result("abstract_ip", {
    asn: { asn: 12810 },
  })]), "12810");
  assert.equal(providerNetworkAsn([result("proxycheck", {
    result: { asn: "AS12810" },
  })]), "12810");
});

test("campaign ASN extraction rejects malformed provider data", () => {
  assert.equal(providerNetworkAsn([result("proxycheck", {
    result: { asn: "unknown" },
  })]), null);
});
