import assert from "node:assert/strict";
import test from "node:test";

import { parseProxycheckResponse } from "../src/enrichment.js";
import { defaultScoreWeights } from "../src/score-catalog.js";

const IP = "203.0.113.10";

test("a positive VPN detection always contributes points", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      detections: {
        anonymous: false,
        proxy: false,
        vpn: true,
        tor: false,
        compromised: false,
        scraper: false,
        hosting: false,
        risk: 50,
      },
      network: {},
    },
  }, IP);

  assert.equal(result.risk, 50);
  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [["proxycheck_anonymous", 25]],
  );
  assert.deepEqual(result.signals[0]?.payload?.detectionTypes, ["vpn"]);
});

test("proxy and Tor detections use the higher network-risk weight", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      detections: {
        anonymous: true,
        proxy: true,
        vpn: false,
        tor: true,
        compromised: false,
        scraper: false,
        hosting: false,
        risk: 80,
      },
      network: { asn: "AS64500", provider: "Example" },
    },
  }, IP);

  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [
      ["proxycheck_anonymous", 55],
      ["proxycheck_risk", 45],
    ],
  );
  assert.deepEqual(
    result.signals[0]?.payload?.detectionTypes,
    ["proxy", "tor"],
  );
});

test("a clean network does not add proxycheck points", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      detections: {
        anonymous: false,
        proxy: false,
        vpn: false,
        tor: false,
        compromised: false,
        scraper: false,
        hosting: false,
        risk: 10,
      },
      network: {},
    },
  }, IP);

  assert.equal(result.risk, 10);
  assert.deepEqual(result.signals, []);
});

test("custom proxycheck weights apply to cached raw responses", () => {
  const weights = defaultScoreWeights();
  weights.proxycheck_anonymous_lower_risk = 41;
  const result = parseProxycheckResponse({
    [IP]: {
      detections: {
        vpn: true,
        risk: 20,
      },
    },
  }, IP, weights);

  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [["proxycheck_anonymous", 41]],
  );
});
