import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFingerprintResponse,
  parseProxycheckResponse,
} from "../src/enrichment.js";
import { defaultScoreWeights } from "../src/score-catalog.js";
import type { Signup } from "../src/types.js";

const IP = "203.0.113.10";
const SIGNUP: Signup = {
  id: "user-1",
  username: "player",
  email: "player@example.com",
  image: null,
  signup_ip: IP,
  country: "DE",
  country_code: "DE",
  continent_code: "EU",
  state: "Berlin",
  city: "Berlin",
  affiliate_code: null,
  referred_by: null,
  is_suspected_alt: false,
  created_at: new Date("2026-07-29T12:00:00.000Z"),
  fingerprint_request_id: "request-1",
  visitor_id: "visitor-1",
  fingerprint_confidence: 0.99,
  fingerprint_ip: IP,
  user_agent: "Mozilla/5.0",
};

function signalMap(result: ReturnType<typeof parseFingerprintResponse>) {
  return new Map(
    result.signals.map((signal) => [signal.key, signal] as const),
  );
}

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
      ["proxycheck_risk", 80],
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

test("ProxyCheck matches equivalent normalized IP response keys", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      risk: 50,
      detections: { vpn: true },
    },
  }, `::ffff:${IP}`);

  assert.deepEqual(
    result.signals.map((signal) => signal.key),
    ["proxycheck_anonymous"],
  );
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

test("ProxyCheck confidence prevents stale low-confidence detections from scoring", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      risk: 20,
      detections: {
        anonymous: true,
        vpn: true,
        confidence: 42,
        first_seen: "2026-06-01",
        last_seen: "2026-06-02",
      },
      network: { provider: "Example VPN" },
    },
  }, IP);

  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [["proxycheck_anonymous", 0]],
  );
  assert.equal(result.signals[0]?.payload?.confidence, 42);
});

test("ProxyCheck borderline confidence reduces rather than fully trusts a detection", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      risk: 20,
      detections: {
        anonymous: true,
        vpn: true,
        confidence: 87,
      },
    },
  }, IP);

  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [["proxycheck_anonymous", 19]],
  );
});

test("ProxyCheck preserves full current evidence without double-counting attacks", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      last_updated: "2026-07-30T10:00:00Z",
      risk: 82,
      network: {
        asn: "AS64500",
        range: "203.0.113.0/24",
        hostname: "edge.example.test",
        provider: "Example Network",
        organisation: "Example Org",
        type: "Hosting",
      },
      location: {
        continent: "Europe",
        country: "Germany",
        isocode: "DE",
        region: "Berlin",
        region_code: "BE",
        city: "Berlin",
        timezone: "Europe/Berlin",
      },
      device_estimate: { address: 12, subnet: 48 },
      detections: {
        anonymous: true,
        proxy: true,
        residential_proxy: true,
        confidence: 96,
        first_seen: "2026-07-20",
        last_seen: "2026-07-30",
      },
      attack_history: {
        login_attempt: 7,
        registration_attempt: 3,
      },
      operator: {
        name: "Example Operator",
        anonymity: "high",
        services: ["residential proxy"],
        protocols: ["http"],
        policies: {
          logging: false,
          crypto_payments: true,
        },
      },
    },
  }, IP);

  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [
      ["proxycheck_anonymous", 55],
      ["proxycheck_risk", 80],
      ["proxycheck_attack_history", 0],
    ],
  );
  assert.deepEqual(
    result.signals[0]?.payload?.detectionTypes,
    ["proxy", "residential_proxy"],
  );
  assert.deepEqual(
    result.signals[2]?.payload?.categories,
    { login_attempt: 7, registration_attempt: 3 },
  );
  assert.equal(result.signals[2]?.payload?.total, 10);
  assert.deepEqual(result.signals[0]?.payload?.deviceEstimate, {
    address: 12,
    subnet: 48,
  });
});

test("ProxyCheck preserves a delisted detection as evidence only", () => {
  const result = parseProxycheckResponse({
    status: "ok",
    [IP]: {
      risk: 5,
      detections: {
        anonymous: false,
        proxy: false,
        vpn: false,
      },
      detection_history: {
        anonymous: {
          delisted: true,
          date: "2026-07-01",
        },
      },
    },
  }, IP);

  assert.deepEqual(
    result.signals.map((signal) => [signal.key, signal.points]),
    [["proxycheck_detection_history", 0]],
  );
  assert.equal(result.signals[0]?.payload?.date, "2026-07-01");
});

test("Fingerprint Pro Plus browser intelligence uses detailed evidence", () => {
  const result = parseFingerprintResponse({
    products: {
      identification: {
        data: {
          ip: IP,
          linkedId: SIGNUP.id,
          replayed: false,
          confidence: { score: 0.99 },
        },
      },
      botd: {
        data: { bot: { result: "bad", type: "headless_chrome" } },
      },
      vpn: {
        data: {
          result: true,
          confidence: "medium",
          mlScore: 0.86,
          originTimezone: "Europe/Berlin",
          originCountry: "DE",
          methods: {
            timezoneMismatch: true,
            publicVPN: true,
            osMismatch: false,
            relay: false,
          },
        },
      },
      proxy: {
        data: {
          result: true,
          confidence: "low",
          mlScore: 0.76,
          details: {
            proxyType: "residential",
            provider: "Example Proxy",
          },
        },
      },
      tor: { data: { result: true } },
      ipInfo: {
        data: {
          v4: {
            address: IP,
            asn: {
              asn: "AS64500",
              name: "Example Network",
              network: "203.0.113.0/24",
              type: "hosting",
            },
            datacenter: { result: true, name: "Example DC" },
            geolocation: {
              country: { code: "DE" },
              city: { name: "Berlin" },
              timezone: "Europe/Berlin",
            },
          },
        },
      },
      ipBlocklist: {
        data: {
          result: true,
          details: { attackSource: true, emailSpam: true },
        },
      },
      incognito: { data: { result: true } },
      tampering: {
        data: {
          result: true,
          confidence: "medium",
          anomalyScore: 0.72,
          mlScore: 0.91,
          antiDetectBrowser: true,
        },
      },
      virtualMachine: { data: { result: true, mlScore: 0.88 } },
      highActivity: {
        data: { result: true, dailyRequests: 321 },
      },
      privacySettings: { data: { result: true } },
      developerTools: { data: { result: true } },
      rareDevice: {
        data: { result: true, percentileBucket: "p99.9+" },
      },
      velocity: {
        data: {
          distinctIp: {
            intervals: { "5m": 3, "1h": 5, "24h": 8 },
          },
          distinctCountry: {
            intervals: { "5m": 2, "1h": 3, "24h": 3 },
          },
          distinctLinkedId: {
            intervals: { "5m": 1, "1h": 2, "24h": 2 },
          },
          events: {
            intervals: { "5m": 10, "1h": 30, "24h": 60 },
          },
          ipEvents: {
            intervals: { "5m": 25, "1h": 50, "24h": 100 },
          },
          distinctIpByLinkedId: {
            intervals: { "5m": 3, "1h": 5, "24h": 8 },
          },
          distinctVisitorIdByLinkedId: {
            intervals: { "5m": 1, "1h": 2, "24h": 2 },
          },
        },
      },
      suspectScore: { data: { result: 40 } },
    },
  }, SIGNUP);
  const signals = signalMap(result);

  assert.equal(result.score, 40);
  assert.equal(signals.get("fingerprint_vpn")?.points, 15);
  assert.equal(signals.get("fingerprint_proxy")?.points, 18);
  assert.equal(signals.get("fingerprint_tampering")?.points, 53);
  assert.equal(
    signals.get("fingerprint_ip_attack_source")?.points,
    80,
  );
  assert.equal(
    signals.get("fingerprint_ip_attack_source")?.payload?.asn,
    "AS64500",
  );
  assert.equal(
    signals.get("fingerprint_velocity_multiple_accounts")?.points,
    90,
  );
  assert.equal(
    signals.get("fingerprint_suspect_score")?.points,
    20,
  );
  for (const key of [
    "fingerprint_bad_bot",
    "fingerprint_tor",
    "fingerprint_datacenter",
    "fingerprint_incognito",
    "fingerprint_virtual_machine",
    "fingerprint_high_activity",
    "fingerprint_privacy_settings",
    "fingerprint_developer_tools",
    "fingerprint_rare_device",
    "fingerprint_velocity_ip_rotation",
    "fingerprint_velocity_country_hop",
    "fingerprint_velocity_automation",
  ]) {
    assert.ok(signals.has(key), `missing ${key}`);
  }
});

test("Fingerprint event integrity cross-checks replay, IP, account and confidence", () => {
  const result = parseFingerprintResponse({
    products: {
      identification: {
        data: {
          ip: "198.51.100.50",
          linkedId: "another-user",
          replayed: true,
          confidence: { score: 0.62 },
        },
      },
    },
  }, SIGNUP);
  const signals = signalMap(result);

  assert.equal(signals.get("fingerprint_event_replayed")?.points, 120);
  assert.equal(signals.get("fingerprint_ip_mismatch")?.points, 90);
  assert.equal(
    signals.get("fingerprint_linked_id_mismatch")?.points,
    120,
  );
  assert.equal(signals.get("fingerprint_low_confidence")?.points, 10);
});

test("mobile integrity and proximity evidence are supported without exposing the zone id", () => {
  const result = parseFingerprintResponse({
    products: {
      identification: {
        data: { ip: IP, replayed: false, confidence: { score: 0.99 } },
      },
      rootApps: { data: { result: true } },
      emulator: { data: { result: true } },
      clonedApp: { data: { result: true } },
      jailbroken: { data: { result: true } },
      frida: { data: { result: true } },
      locationSpoofing: { data: { result: true } },
      mitmAttack: { data: { result: true } },
      factoryReset: { data: { time: "2026-07-20T12:00:00.000Z" } },
      proximity: {
        data: {
          id: "sensitive-zone-id",
          precisionRadius: 450,
          confidence: 0.94,
        },
      },
    },
  }, SIGNUP);
  const signals = signalMap(result);
  const proximity = signals.get("fingerprint_proximity");

  for (const key of [
    "fingerprint_mobile_rooted",
    "fingerprint_mobile_emulator",
    "fingerprint_mobile_cloned_app",
    "fingerprint_mobile_jailbroken",
    "fingerprint_mobile_frida",
    "fingerprint_mobile_location_spoofing",
    "fingerprint_mobile_mitm",
    "fingerprint_mobile_recent_factory_reset",
  ]) {
    assert.ok(signals.has(key), `missing ${key}`);
  }
  assert.equal(proximity?.points, 0);
  assert.match(String(proximity?.payload?.zoneHash), /^[a-f0-9]{64}$/);
  assert.equal(
    JSON.stringify(proximity).includes("sensitive-zone-id"),
    false,
  );
});

test("clean Fingerprint events do not create risk signals", () => {
  const result = parseFingerprintResponse({
    products: {
      identification: {
        data: {
          ip: IP,
          linkedId: SIGNUP.id,
          replayed: false,
          confidence: { score: 0.99 },
        },
      },
      botd: { data: { bot: { result: "notDetected" } } },
      vpn: { data: { result: false, confidence: "high" } },
      proxy: { data: { result: false, confidence: "high" } },
      tor: { data: { result: false } },
      ipBlocklist: {
        data: {
          result: false,
          details: { attackSource: false, emailSpam: false },
        },
      },
      ipInfo: {
        data: {
          v4: {
            address: IP,
            datacenter: { result: false, name: "" },
            geolocation: {},
          },
        },
      },
      incognito: { data: { result: false } },
      tampering: { data: { result: false, confidence: "high" } },
      virtualMachine: { data: { result: false } },
      highActivity: { data: { result: false } },
      privacySettings: { data: { result: false } },
      developerTools: { data: { result: false } },
      suspectScore: { data: { result: 0 } },
    },
  }, SIGNUP);

  assert.equal(result.score, 0);
  assert.deepEqual(result.signals, []);
});
