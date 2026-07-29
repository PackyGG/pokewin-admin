import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  FingerprintJsServerApiClient,
  Region,
} from "@fingerprintjs/fingerprintjs-pro-server-api";

import type { Config } from "./config.js";
import {
  defaultScoreWeights,
  scorePoints,
  type ScoreWeights,
} from "./score-catalog.js";
import type { Signal, Signup } from "./types.js";

type JsonObject = Record<string, unknown>;

/**
 * Wall-clock bound for the Fingerprint Server API. The SDK exposes no
 * AbortSignal, so a blackholed load balancer would otherwise hang
 * `processSignup` forever while the engine's tick stays marked running.
 */
const FINGERPRINT_TIMEOUT_MS = 5_000;

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`${label}_timeout`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object"
    ? (value as JsonObject)
    : {};
}

function path(value: unknown, ...parts: string[]): unknown {
  let current: unknown = value;
  for (const part of parts) current = object(current)[part];
  return current;
}

function truthy(value: unknown, ...parts: string[]): boolean {
  return path(value, ...parts) === true;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function canonicalIp(value: unknown): string | undefined {
  const raw = stringValue(value)?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.startsWith("::ffff:") && isIP(raw.slice(7)) === 4) {
    return raw.slice(7);
  }
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version !== 6) return undefined;
  try {
    return new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return raw;
  }
}

export type FingerprintEventIdentity = {
  visitorId: string | null;
  linkedId: string | null;
  eventIp: string | null;
  eventTime: Date | null;
  replayed: boolean;
};

export function fingerprintEventIdentity(
  raw: unknown,
): FingerprintEventIdentity {
  const identification = object(
    path(object(raw), "products", "identification", "data"),
  );
  const time = stringValue(identification.time);
  const eventTime = time ? new Date(time) : null;
  return {
    visitorId: stringValue(identification.visitorId) ?? null,
    linkedId: stringValue(identification.linkedId) ?? null,
    eventIp: canonicalIp(identification.ip) ?? null,
    eventTime:
      eventTime && Number.isFinite(eventTime.getTime()) ? eventTime : null,
    replayed: identification.replayed === true,
  };
}

function confidencePoints(points: number, confidence: unknown): number {
  if (confidence === "low") return Math.round(points * 0.5);
  if (confidence === "medium") return Math.round(points * 0.75);
  return points;
}

function intervalCount(
  velocity: JsonObject,
  key: string,
  interval: "5m" | "1h" | "24h",
): number {
  return numberValue(path(velocity, key, "intervals", interval)) ?? 0;
}

function signalPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function proxycheckResultNode(
  raw: JsonObject,
  signupIp: string,
): JsonObject {
  const expected = canonicalIp(signupIp);
  for (const source of [raw, object(raw.data)]) {
    const direct = source[signupIp];
    if (direct !== undefined) return object(direct);
    if (!expected) continue;
    for (const [key, value] of Object.entries(source)) {
      if (canonicalIp(key) === expected) return object(value);
    }
  }
  return {};
}

export type EnrichmentResult = {
  provider: "fingerprint" | "proxycheck";
  status: "success" | "skipped" | "failed";
  lookupKey: string;
  requestId?: string;
  score?: number;
  response?: JsonObject;
  errorCode?: string;
  signals: Signal[];
};

export type ProxycheckTag = "signup" | "fiat-eligibility";

export function reweightFingerprintSignals(
  signals: Signal[],
  weights: ScoreWeights,
): Signal[] {
  const points = scorePoints(weights);
  const fixed: Record<string, number> = {
    fingerprint_missing: points.fingerprintMissing,
    fingerprint_event_replayed: points.fingerprintEventReplayed,
    fingerprint_ip_mismatch: points.fingerprintIpMismatch,
    fingerprint_linked_id_mismatch: points.fingerprintLinkedIdMismatch,
    fingerprint_low_confidence: points.fingerprintLowConfidence,
    fingerprint_bad_bot: points.fingerprintBadBot,
    fingerprint_tor: points.fingerprintTor,
    fingerprint_ip_attack_source: points.fingerprintIpAttackSource,
    fingerprint_ip_email_spam: points.fingerprintIpEmailSpam,
    fingerprint_datacenter: points.fingerprintDatacenter,
    fingerprint_incognito: points.fingerprintIncognito,
    fingerprint_virtual_machine: points.fingerprintVirtualMachine,
    fingerprint_high_activity: points.fingerprintHighActivity,
    fingerprint_privacy_settings: points.fingerprintPrivacySettings,
    fingerprint_developer_tools: points.fingerprintDeveloperTools,
    fingerprint_rare_device: points.fingerprintRareDevice,
    fingerprint_velocity_ip_rotation:
      points.fingerprintVelocityIpRotation,
    fingerprint_velocity_country_hop:
      points.fingerprintVelocityCountryHop,
    fingerprint_velocity_multiple_accounts:
      points.fingerprintVelocityMultipleAccounts,
    fingerprint_velocity_automation:
      points.fingerprintVelocityAutomation,
    fingerprint_mobile_rooted: points.fingerprintMobileRooted,
    fingerprint_mobile_emulator: points.fingerprintMobileEmulator,
    fingerprint_mobile_cloned_app: points.fingerprintMobileClonedApp,
    fingerprint_mobile_jailbroken: points.fingerprintMobileJailbroken,
    fingerprint_mobile_frida: points.fingerprintMobileFrida,
    fingerprint_mobile_location_spoofing:
      points.fingerprintMobileLocationSpoofing,
    fingerprint_mobile_mitm: points.fingerprintMobileMitm,
    fingerprint_mobile_recent_factory_reset:
      points.fingerprintMobileRecentFactoryReset,
    fingerprint_proximity: points.fingerprintProximity,
  };

  return signals.map((signal) => {
    const confidence = signal.payload?.confidence;
    if (signal.key === "fingerprint_vpn") {
      return {
        ...signal,
        points: confidencePoints(points.fingerprintVpn, confidence),
      };
    }
    if (signal.key === "fingerprint_proxy") {
      return {
        ...signal,
        points: confidencePoints(points.fingerprintProxy, confidence),
      };
    }
    if (signal.key === "fingerprint_tampering") {
      return {
        ...signal,
        points: confidencePoints(points.fingerprintTampering, confidence),
      };
    }
    if (signal.key === "fingerprint_suspect_score") {
      const suspectScore = Number(signal.payload?.suspectScore ?? 0);
      return {
        ...signal,
        points: Number.isFinite(suspectScore)
          ? Math.min(
              points.fingerprintSuspectScore.maximum,
              Math.round(
                suspectScore / points.fingerprintSuspectScore.divisor,
              ),
            )
          : signal.points,
      };
    }
    return Object.hasOwn(fixed, signal.key)
      ? { ...signal, points: fixed[signal.key] ?? signal.points }
      : signal;
  });
}

export function parseFingerprintResponse(
  raw: JsonObject,
  signup: Signup,
  weights: ScoreWeights = defaultScoreWeights(),
): { score: number; signals: Signal[] } {
  const SCORE_POINTS = scorePoints(weights);
  const products = object(raw.products);
  const identification = object(path(products, "identification", "data"));
  const signals: Signal[] = [];
  const add = (
    hit: boolean,
    key: string,
    title: string,
    detail: string,
    points: number,
    payload?: Record<string, unknown>,
  ) => {
    if (hit) {
      signals.push({
        key,
        title,
        detail,
        points,
        ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
      });
    }
  };

  const eventIp = canonicalIp(identification.ip);
  const expectedIps = [
    canonicalIp(signup.fingerprint_ip),
    canonicalIp(signup.signup_ip),
  ].filter((value): value is string => Boolean(value));
  const linkedId = stringValue(identification.linkedId);
  const confidence =
    numberValue(path(identification, "confidence", "score"))
    ?? signup.fingerprint_confidence
    ?? undefined;

  add(
    identification.replayed === true,
    "fingerprint_event_replayed",
    "Fingerprint payload replayed",
    "Fingerprint marked the identification payload as replayed.",
    SCORE_POINTS.fingerprintEventReplayed,
    { requestId: signup.fingerprint_request_id },
  );
  add(
    Boolean(
      eventIp
      && expectedIps.length > 0
      && !expectedIps.includes(eventIp),
    ),
    "fingerprint_ip_mismatch",
    "Fingerprint IP mismatch",
    "The Fingerprint event IP does not match the signup or backend-captured IP.",
    SCORE_POINTS.fingerprintIpMismatch,
    { eventIp, expectedIps },
  );
  add(
    Boolean(linkedId && linkedId !== signup.id),
    "fingerprint_linked_id_mismatch",
    "Fingerprint account mismatch",
    "The Fingerprint event is linked to a different account.",
    SCORE_POINTS.fingerprintLinkedIdMismatch,
    { linkedId, expectedUserId: signup.id },
  );
  add(
    confidence !== undefined && confidence < 0.9,
    "fingerprint_low_confidence",
    "Low fingerprint confidence",
    `Fingerprint identification confidence is ${Math.round((confidence ?? 0) * 100)}%.`,
    SCORE_POINTS.fingerprintLowConfidence,
    { confidence },
  );

  const ipInfo = object(path(products, "ipInfo", "data"));
  const ipNode = object(
    (eventIp?.includes(":") ? ipInfo.v6 : ipInfo.v4)
    ?? ipInfo.v4
    ?? ipInfo.v6,
  );
  const asn = object(ipNode.asn);
  const datacenter = object(ipNode.datacenter);
  const geolocation = object(ipNode.geolocation);
  const networkContext = signalPayload({
    asn: asn.asn,
    asnName: asn.name,
    asnNetwork: asn.network,
    asnType: asn.type,
    datacenterName: datacenter.name,
    countryCode: path(geolocation, "country", "code"),
    city: path(geolocation, "city", "name"),
    timezone: geolocation.timezone,
  });

  const bot = object(path(products, "botd", "data", "bot"));
  const botType = stringValue(bot.type);
  add(
    bot.result === "bad",
    "fingerprint_bad_bot",
    botType ? `Bad bot: ${botType}` : "Bad bot detected",
    "Fingerprint identified browser automation or a malicious bot.",
    SCORE_POINTS.fingerprintBadBot,
    signalPayload({ botType }),
  );

  const vpn = object(path(products, "vpn", "data"));
  const vpnMethods = object(vpn.methods);
  const vpnMethodNames = [
    ["timezoneMismatch", "timezone mismatch"],
    ["publicVPN", "public VPN"],
    ["auxiliaryMobile", "mobile VPN evidence"],
    ["osMismatch", "OS/network mismatch"],
    ["relay", "relay service"],
    ["mlPrediction", "ML prediction"],
  ] as const;
  const activeVpnMethods = vpnMethodNames
    .filter(([key]) => vpnMethods[key] === true)
    .map(([, label]) => label);
  const vpnConfidence = stringValue(vpn.confidence);
  const vpnMlScore =
    numberValue(vpn.mlScore) ?? numberValue(vpn.ml_score);
  add(
    vpn.result === true,
    "fingerprint_vpn",
    vpnConfidence ? `VPN detected (${vpnConfidence} confidence)` : "VPN detected",
    activeVpnMethods.length > 0
      ? `Fingerprint matched ${activeVpnMethods.join(", ")}.`
      : "Fingerprint detected VPN or anonymizing-network use.",
    confidencePoints(SCORE_POINTS.fingerprintVpn, vpnConfidence),
    signalPayload({
      confidence: vpnConfidence,
      mlScore: vpnMlScore,
      methods: vpnMethods,
      originTimezone: vpn.originTimezone,
      originCountry: vpn.originCountry,
      ...networkContext,
    }),
  );

  const proxy = object(path(products, "proxy", "data"));
  const proxyDetails = object(proxy.details);
  const proxyConfidence = stringValue(proxy.confidence);
  const proxyType =
    stringValue(proxyDetails.proxyType)
    ?? stringValue(proxyDetails.proxy_type)
    ?? "unknown";
  const proxyMlScore =
    numberValue(proxy.mlScore) ?? numberValue(proxy.ml_score);
  add(
    proxy.result === true,
    "fingerprint_proxy",
    `${proxyType.replaceAll("_", " ")} proxy detected`,
    proxyConfidence
      ? `Fingerprint classified the proxy with ${proxyConfidence} confidence.`
      : "Fingerprint detected public or residential proxy traffic.",
    confidencePoints(SCORE_POINTS.fingerprintProxy, proxyConfidence),
    signalPayload({
      confidence: proxyConfidence,
      mlScore: proxyMlScore,
      proxyType,
      provider: proxyDetails.provider,
      lastSeenAt: proxyDetails.lastSeenAt ?? proxyDetails.last_seen_at,
      ...networkContext,
    }),
  );

  add(
    truthy(products, "tor", "data", "result"),
    "fingerprint_tor",
    "Tor detected",
    "Fingerprint identified a Tor exit node.",
    SCORE_POINTS.fingerprintTor,
    networkContext,
  );

  const blocklist = object(path(products, "ipBlocklist", "data"));
  const blocklistDetails = object(blocklist.details);
  const attackSource =
    blocklistDetails.attackSource === true
    || blocklistDetails.attack_source === true;
  const emailSpam =
    blocklistDetails.emailSpam === true
    || blocklistDetails.email_spam === true;
  const blocklistTypes = [
    attackSource ? "network attack" : null,
    emailSpam ? "email spam" : null,
  ].filter((value): value is string => Boolean(value));
  add(
    blocklist.result === true || attackSource || emailSpam,
    attackSource
      ? "fingerprint_ip_attack_source"
      : "fingerprint_ip_email_spam",
    attackSource ? "Known network-attack IP" : "Known email-spam IP",
    blocklistTypes.length > 0
      ? `Fingerprint matched ${blocklistTypes.join(" and ")} history.`
      : "Fingerprint found the IP in a malicious-activity blocklist.",
    attackSource
      ? SCORE_POINTS.fingerprintIpAttackSource
      : SCORE_POINTS.fingerprintIpEmailSpam,
    signalPayload({ blocklistTypes, ...networkContext }),
  );

  add(
    datacenter.result === true,
    "fingerprint_datacenter",
    stringValue(datacenter.name)
      ? `Datacenter network: ${datacenter.name}`
      : "Datacenter network",
    "Fingerprint identified the request IP as datacenter-hosted.",
    SCORE_POINTS.fingerprintDatacenter,
    networkContext,
  );

  add(
    truthy(products, "incognito", "data", "result"),
    "fingerprint_incognito",
    "Private browsing",
    "The account was created in private/incognito mode.",
    SCORE_POINTS.fingerprintIncognito,
  );

  const tampering = object(path(products, "tampering", "data"));
  const tamperingConfidence = stringValue(tampering.confidence);
  const anomalyScore =
    numberValue(tampering.anomalyScore)
    ?? numberValue(tampering.anomaly_score);
  const tamperingMlScore =
    numberValue(tampering.mlScore) ?? numberValue(tampering.ml_score);
  const antiDetect =
    tampering.antiDetectBrowser === true
    || tampering.anti_detect_browser === true;
  add(
    tampering.result === true,
    "fingerprint_tampering",
    antiDetect ? "Anti-detect browser" : "Browser tampering",
    tamperingConfidence
      ? `Fingerprint classified browser tampering with ${tamperingConfidence} confidence.`
      : "Fingerprint detected anomalous or manipulated browser attributes.",
    confidencePoints(
      SCORE_POINTS.fingerprintTampering,
      tamperingConfidence,
    ),
    signalPayload({
      confidence: tamperingConfidence,
      anomalyScore,
      mlScore: tamperingMlScore,
      antiDetectBrowser: antiDetect,
    }),
  );

  const virtualMachine = object(path(products, "virtualMachine", "data"));
  const vmMlScore =
    numberValue(virtualMachine.mlScore)
    ?? numberValue(virtualMachine.ml_score);
  add(
    virtualMachine.result === true,
    "fingerprint_virtual_machine",
    "Virtual machine",
    vmMlScore === undefined
      ? "The signup browser appears to run in a virtual machine."
      : `Fingerprint returned a VM likelihood of ${Math.round(vmMlScore * 100)}%.`,
    SCORE_POINTS.fingerprintVirtualMachine,
    signalPayload({ mlScore: vmMlScore }),
  );

  const highActivity = object(path(products, "highActivity", "data"));
  const dailyRequests =
    numberValue(highActivity.dailyRequests)
    ?? numberValue(highActivity.daily_requests);
  add(
    highActivity.result === true,
    "fingerprint_high_activity",
    "High-activity device",
    dailyRequests === undefined
      ? "The device is among the most active devices seen by Fingerprint."
      : `Fingerprint saw ${dailyRequests} requests from this device in the previous day.`,
    SCORE_POINTS.fingerprintHighActivity,
    signalPayload({ dailyRequests }),
  );

  add(
    truthy(products, "privacySettings", "data", "result"),
    "fingerprint_privacy_settings",
    "Privacy-focused browser settings",
    "Fingerprint detected settings that conceal or randomize browser attributes.",
    SCORE_POINTS.fingerprintPrivacySettings,
  );
  add(
    truthy(products, "developerTools", "data", "result"),
    "fingerprint_developer_tools",
    "Developer tools or CDP detected",
    "Fingerprint detected open developer tools or browser control through the DevTools protocol.",
    SCORE_POINTS.fingerprintDeveloperTools,
  );

  const rareDevice = object(
    path(products, "rareDevice", "data")
    ?? path(products, "rare_device", "data"),
  );
  const rareResult =
    rareDevice.result === true
    || rareDevice.rareDevice === true
    || rareDevice.rare_device === true;
  const rarityBucket =
    stringValue(rareDevice.percentileBucket)
    ?? stringValue(rareDevice.percentile_bucket)
    ?? stringValue(rareDevice.rareDevicePercentileBucket)
    ?? stringValue(rareDevice.rare_device_percentile_bucket);
  add(
    rareResult,
    "fingerprint_rare_device",
    rarityBucket ? `Rare device (${rarityBucket})` : "Rare device",
    "Fingerprint identified a statistically uncommon device configuration.",
    SCORE_POINTS.fingerprintRareDevice,
    signalPayload({ percentileBucket: rarityBucket }),
  );

  const velocity = object(path(products, "velocity", "data"));
  const velocityPayload = signalPayload({
    distinctIp: object(path(velocity, "distinctIp", "intervals")),
    distinctCountry: object(
      path(velocity, "distinctCountry", "intervals"),
    ),
    distinctLinkedId: object(
      path(velocity, "distinctLinkedId", "intervals"),
    ),
    events: object(path(velocity, "events", "intervals")),
    ipEvents: object(path(velocity, "ipEvents", "intervals")),
    distinctIpByLinkedId: object(
      path(velocity, "distinctIpByLinkedId", "intervals"),
    ),
    distinctVisitorIdByLinkedId: object(
      path(velocity, "distinctVisitorIdByLinkedId", "intervals"),
    ),
  });
  const rotatingIps =
    intervalCount(velocity, "distinctIp", "5m") >= 3
    || intervalCount(velocity, "distinctIp", "1h") >= 5
    || intervalCount(velocity, "distinctIpByLinkedId", "5m") >= 3
    || intervalCount(velocity, "distinctIpByLinkedId", "1h") >= 5;
  add(
    rotatingIps,
    "fingerprint_velocity_ip_rotation",
    "Rapid IP rotation",
    "Fingerprint observed the device or linked account across several IPs in a short window.",
    SCORE_POINTS.fingerprintVelocityIpRotation,
    velocityPayload,
  );
  const countryHop =
    intervalCount(velocity, "distinctCountry", "5m") >= 2
    || intervalCount(velocity, "distinctCountry", "1h") >= 3;
  add(
    countryHop,
    "fingerprint_velocity_country_hop",
    "Rapid country changes",
    "Fingerprint observed the device in multiple countries within a short window.",
    SCORE_POINTS.fingerprintVelocityCountryHop,
    velocityPayload,
  );
  const multipleAccounts =
    intervalCount(velocity, "distinctLinkedId", "24h") >= 2
    || intervalCount(
      velocity,
      "distinctVisitorIdByLinkedId",
      "24h",
    ) >= 2;
  add(
    multipleAccounts,
    "fingerprint_velocity_multiple_accounts",
    "Multiple linked accounts or devices",
    "Fingerprint velocity connects this device or linked account to multiple account identities.",
    SCORE_POINTS.fingerprintVelocityMultipleAccounts,
    velocityPayload,
  );
  const automationVelocity =
    intervalCount(velocity, "events", "5m") >= 10
    || intervalCount(velocity, "events", "1h") >= 30
    || intervalCount(velocity, "ipEvents", "5m") >= 25;
  add(
    automationVelocity,
    "fingerprint_velocity_automation",
    "Automation-like event velocity",
    "Fingerprint observed unusually dense device or IP identification activity.",
    SCORE_POINTS.fingerprintVelocityAutomation,
    velocityPayload,
  );

  const mobileSignals = [
    {
      product: "rootApps",
      key: "fingerprint_mobile_rooted",
      title: "Root-management apps detected",
      detail: "Fingerprint detected Android root-management software.",
      points: SCORE_POINTS.fingerprintMobileRooted,
    },
    {
      product: "emulator",
      key: "fingerprint_mobile_emulator",
      title: "Mobile emulator detected",
      detail: "Fingerprint detected an emulated mobile environment.",
      points: SCORE_POINTS.fingerprintMobileEmulator,
    },
    {
      product: "clonedApp",
      key: "fingerprint_mobile_cloned_app",
      title: "Cloned mobile app",
      detail: "Fingerprint detected a cloned application or work profile.",
      points: SCORE_POINTS.fingerprintMobileClonedApp,
    },
    {
      product: "jailbroken",
      key: "fingerprint_mobile_jailbroken",
      title: "Jailbroken device",
      detail: "Fingerprint detected an iOS jailbreak.",
      points: SCORE_POINTS.fingerprintMobileJailbroken,
    },
    {
      product: "frida",
      key: "fingerprint_mobile_frida",
      title: "Frida instrumentation detected",
      detail: "Fingerprint detected Frida runtime instrumentation.",
      points: SCORE_POINTS.fingerprintMobileFrida,
    },
    {
      product: "locationSpoofing",
      key: "fingerprint_mobile_location_spoofing",
      title: "Location spoofing",
      detail: "Fingerprint detected spoofed mobile-device location.",
      points: SCORE_POINTS.fingerprintMobileLocationSpoofing,
    },
    {
      product: "mitmAttack",
      key: "fingerprint_mobile_mitm",
      title: "Mobile MitM interception",
      detail: "Fingerprint detected possible interception of the mobile request.",
      points: SCORE_POINTS.fingerprintMobileMitm,
    },
  ] as const;
  for (const mobile of mobileSignals) {
    add(
      truthy(products, mobile.product, "data", "result"),
      mobile.key,
      mobile.title,
      mobile.detail,
      mobile.points,
    );
  }

  const factoryReset = object(path(products, "factoryReset", "data"));
  const factoryResetAt = Date.parse(
    stringValue(factoryReset.time) ?? "",
  );
  const factoryResetAge =
    signup.created_at.getTime() - factoryResetAt;
  add(
    Number.isFinite(factoryResetAt)
      && factoryResetAt > 0
      && factoryResetAge >= -5 * 60 * 1000
      && factoryResetAge <= 30 * 24 * 60 * 60 * 1000,
    "fingerprint_mobile_recent_factory_reset",
    "Recent mobile factory reset",
    "Fingerprint reports a factory reset within 30 days before signup.",
    SCORE_POINTS.fingerprintMobileRecentFactoryReset,
    signalPayload({
      resetAt: Number.isFinite(factoryResetAt)
        ? new Date(factoryResetAt).toISOString()
        : undefined,
    }),
  );

  const proximity = object(path(products, "proximity", "data"));
  const proximityId = stringValue(proximity.id);
  const proximityHash = proximityId
    ? createHash("sha256")
        .update("packy:fingerprint-proximity:v1:")
        .update(proximityId)
        .digest("hex")
    : undefined;
  const precisionRadius = numberValue(
    proximity.precisionRadius ?? proximity.precision_radius,
  );
  const proximityConfidence = numberValue(proximity.confidence);
  add(
    Boolean(proximityId),
    "fingerprint_proximity",
    "Coarse proximity evidence available",
    precisionRadius === undefined
      ? "Fingerprint returned a privacy-preserving coarse proximity zone."
      : `Fingerprint returned a coarse ${precisionRadius}-meter proximity zone.`,
    SCORE_POINTS.fingerprintProximity,
    signalPayload({
      zoneHash: proximityHash,
      precisionRadius,
      confidence: proximityConfidence,
    }),
  );

  const suspectScore = Number(
    path(products, "suspectScore", "data", "result") ?? 0,
  );
  if (
    Number.isFinite(suspectScore)
    && suspectScore >= SCORE_POINTS.fingerprintSuspectScore.threshold
  ) {
    signals.push({
      key: "fingerprint_suspect_score",
      title: "Fingerprint suspect score",
      detail: `Fingerprint returned a suspect score of ${suspectScore}.`,
      points: Math.min(
        SCORE_POINTS.fingerprintSuspectScore.maximum,
        Math.round(
          suspectScore / SCORE_POINTS.fingerprintSuspectScore.divisor,
        ),
      ),
      payload: { suspectScore },
    });
  }

  return {
    score: Number.isFinite(suspectScore) ? suspectScore : 0,
    signals,
  };
}

export function parseProxycheckResponse(
  raw: JsonObject,
  signupIp: string,
  weights: ScoreWeights = defaultScoreWeights(),
): { risk: number; signals: Signal[] } {
  const SCORE_POINTS = scorePoints(weights);
  const node = proxycheckResultNode(raw, signupIp);
  const detections = object(node.detections);
  const network = object(node.network);
  const location = object(node.location);
  const deviceEstimate = object(node.device_estimate);
  const detectionHistory = object(node.detection_history);
  const anonymousHistory = object(detectionHistory.anonymous);
  const attackHistory = object(node.attack_history);
  const operator = object(node.operator);
  const policies = object(operator.policies);
  const risk = Number(
    detections.risk
      ?? node.risk
      ?? object(node.risk_score).score
      ?? raw.risk
      ?? 0,
  );
  const metadataKeys = new Set([
    "anonymous",
    "confidence",
    "first_seen",
    "last_seen",
    "risk",
    "type",
    "operator_type",
  ]);
  const detectionTypes = Object.entries(detections)
    .filter(([key, value]) => !metadataKeys.has(key) && value === true)
    .map(([key]) => key)
    .sort();
  const anonymous =
    node.proxy === "yes" ||
    node.anonymous === true ||
    detections.anonymous === true;
  const positiveDetection = anonymous || detectionTypes.length > 0;
  const type = String(
    detectionTypes.join(", ")
      || node.type
      || detections.type
      || detections.operator_type
      || "",
  ).toLowerCase();
  const confidence = numberValue(detections.confidence);
  const allAttackEntries = Object.entries(attackHistory)
    .map(([key, value]) => [key, numberValue(value) ?? 0] as const)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1]);
  const attackTotal = allAttackEntries.reduce(
    (total, [, count]) => total + count,
    0,
  );
  const attackEntries = allAttackEntries.slice(0, 20);
  const networkEvidence = signalPayload({
    asn: network.asn ?? node.asn,
    range: network.range,
    hostname: network.hostname,
    provider: network.provider ?? node.provider,
    organisation: network.organisation,
    type: network.type,
  });
  const locationEvidence = signalPayload({
    continent: location.continent,
    country: location.country,
    isocode: location.isocode,
    region: location.region,
    regionCode: location.region_code,
    city: location.city,
    timezone: location.timezone,
  });
  const operatorEvidence = signalPayload({
    name: operator.name,
    url: operator.url,
    anonymity: operator.anonymity,
    popularity: operator.popularity,
    services: Array.isArray(operator.services)
      ? operator.services.slice(0, 20)
      : undefined,
    protocols: Array.isArray(operator.protocols)
      ? operator.protocols.slice(0, 20)
      : undefined,
    policies: signalPayload({
      adFiltering: policies.ad_filtering,
      freeAccess: policies.free_access,
      paidAccess: policies.paid_access,
      portForwarding: policies.port_forwarding,
      logging: policies.logging,
      anonymousPayments: policies.anonymous_payments,
      cryptoPayments: policies.crypto_payments,
      traceableOwnership: policies.traceable_ownership,
    }),
    additionalOperators: Array.isArray(operator.additional_operators)
      ? operator.additional_operators.slice(0, 20)
      : undefined,
  });
  const networkProvider = stringValue(
    network.provider ?? network.organisation ?? operator.name,
  );
  const networkType = stringValue(network.type);
  const lastSeen = stringValue(detections.last_seen);
  const commonEvidence = {
    confidence,
    firstSeen: detections.first_seen,
    lastSeen: detections.last_seen,
    lastUpdated: node.last_updated,
    network: networkEvidence,
    location: locationEvidence,
    deviceEstimate: signalPayload({
      address: deviceEstimate.address,
      subnet: deviceEstimate.subnet,
    }),
    operator: operatorEvidence,
  };
  const signals: Signal[] = [];

  if (positiveDetection) {
    const basePoints = /tor|proxy|compromised/.test(type)
      ? SCORE_POINTS.proxycheckAnonymous.torProxyCompromised
      : SCORE_POINTS.proxycheckAnonymous.lowerRisk;
    const points = confidence === undefined || confidence >= 90
      ? basePoints
      : confidence >= 85
        ? Math.round(basePoints * 0.75)
        : 0;
    const confidenceDetail = confidence === undefined
      ? ""
      : ` Detection confidence is ${confidence}%.`;
    const providerDetail = networkProvider
      ? ` Network: ${networkProvider}${networkType ? ` (${networkType})` : ""}.`
      : "";
    const seenDetail = lastSeen ? ` Last seen: ${lastSeen}.` : "";
    signals.push({
      key: "proxycheck_anonymous",
      title: type ? `Anonymous IP: ${type}` : "Anonymous IP detected",
      detail:
        `proxycheck.io identified anonymized or proxy traffic.${confidenceDetail}${providerDetail}${seenDetail}`,
      points,
      payload: {
        type,
        detectionTypes,
        ...commonEvidence,
      },
    });
  }
  if (
    Number.isFinite(risk) &&
    risk >= SCORE_POINTS.proxycheckRisk.threshold
  ) {
    signals.push({
      key: "proxycheck_risk",
      title: "High-risk IP",
      detail:
        `proxycheck.io returned a risk score of ${risk}.`
        + (networkProvider ? ` Network: ${networkProvider}.` : ""),
      points:
        risk >= SCORE_POINTS.proxycheckRisk.highThreshold
          ? SCORE_POINTS.proxycheckRisk.high
          : SCORE_POINTS.proxycheckRisk.medium,
      payload: {
        risk,
        ...commonEvidence,
      },
    });
  }
  if (attackTotal > 0) {
    const attackSummary = attackEntries
      .slice(0, 4)
      .map(([category, count]) => `${category.replaceAll("_", " ")}: ${count}`)
      .join(", ");
    signals.push({
      key: "proxycheck_attack_history",
      title: "IP attack history",
      detail:
        `proxycheck.io recorded ${attackTotal} attack event${attackTotal === 1 ? "" : "s"} for this IP.`
        + (attackSummary ? ` ${attackSummary}.` : ""),
      // ProxyCheck already incorporates attack history into its live risk score.
      // Preserve the evidence without counting the same behavior twice.
      points: 0,
      payload: {
        total: attackTotal,
        categories: Object.fromEntries(attackEntries),
        ...commonEvidence,
      },
    });
  }
  if (
    anonymousHistory.delisted === true
    && !positiveDetection
  ) {
    signals.push({
      key: "proxycheck_detection_history",
      title: "Previously anonymous IP",
      detail:
        "proxycheck.io previously listed this IP as anonymous."
        + (
          stringValue(anonymousHistory.date)
            ? ` Delisted: ${String(anonymousHistory.date)}.`
            : ""
        ),
      points: 0,
      payload: {
        delisted: true,
        date: anonymousHistory.date,
        ...commonEvidence,
      },
    });
  }

  return {
    risk: Number.isFinite(risk) ? risk : 0,
    signals,
  };
}

export class EnrichmentService {
  private readonly fingerprint: FingerprintJsServerApiClient;

  constructor(private readonly config: Config) {
    const region =
      config.FINGERPRINT_REGION === "eu"
        ? Region.EU
        : config.FINGERPRINT_REGION === "ap"
          ? Region.AP
          : Region.Global;
    this.fingerprint = new FingerprintJsServerApiClient({
      apiKey: config.FINGERPRINT_SECRET_API_KEY,
      region,
    });
  }

  /** Redacts configured secrets out of provider error text. */
  private scrub(value: string): string {
    return [
      this.config.FINGERPRINT_SECRET_API_KEY,
      this.config.PROXYCHECK_API_KEY,
      this.config.API_TOKEN,
      this.config.API_ADMIN_TOKEN,
      this.config.FIAT_ELIGIBILITY_DEV_API_KEY,
      this.config.FIAT_ELIGIBILITY_PROD_API_KEY,
    ].filter((secret): secret is string => Boolean(secret)).reduce(
      (message, secret) =>
        secret ? message.replaceAll(secret, "[redacted]") : message,
      value,
    );
  }

  async fingerprintCheck(
    signup: Signup,
    weights: ScoreWeights = defaultScoreWeights(),
  ): Promise<EnrichmentResult> {
    const SCORE_POINTS = scorePoints(weights);
    if (!signup.fingerprint_request_id) {
      return {
        provider: "fingerprint",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode: "missing_request_id",
        signals: [{
          key: "fingerprint_missing",
          title: "Fingerprint missing",
          detail: "Signup completed without a stored Fingerprint event.",
          points: SCORE_POINTS.fingerprintMissing,
        }],
      };
    }

    try {
      const event = await withTimeout(
        this.fingerprint.getEvent(signup.fingerprint_request_id),
        FINGERPRINT_TIMEOUT_MS,
        "fingerprint",
      );
      const raw = JSON.parse(JSON.stringify(event)) as JsonObject;
      const parsed = parseFingerprintResponse(raw, signup, weights);

      return {
        provider: "fingerprint",
        status: "success",
        lookupKey: signup.fingerprint_request_id,
        requestId: signup.fingerprint_request_id,
        score: parsed.score,
        response: raw,
        signals: parsed.signals,
      };
    } catch (error) {
      return {
        provider: "fingerprint",
        status: "failed",
        lookupKey: signup.fingerprint_request_id,
        requestId: signup.fingerprint_request_id,
        errorCode: error instanceof Error ? error.name : "unknown_error",
        signals: [],
      };
    }
  }

  async proxycheck(
    signup: Signup,
    weights: ScoreWeights = defaultScoreWeights(),
    tag: ProxycheckTag = "signup",
  ): Promise<EnrichmentResult> {
    if (!signup.signup_ip) {
      return {
        provider: "proxycheck",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode: "missing_ip",
        signals: [],
      };
    }

    const url = new URL(
      `https://proxycheck.io/v3/${encodeURIComponent(signup.signup_ip)}`,
    );
    url.searchParams.set("key", this.config.PROXYCHECK_API_KEY);
    url.searchParams.set("days", "30");
    url.searchParams.set("p", "0");
    url.searchParams.set("ver", "24-June-2026");
    url.searchParams.set("tag", tag);

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const raw = object(await response.json());
      const resultNode = proxycheckResultNode(raw, signup.signup_ip);
      if (
        Object.keys(resultNode).length === 0
        || !["ok", "warning"].includes(String(raw.status ?? "").toLowerCase())
      ) {
        throw new Error("invalid_response");
      }
      const { risk, signals } = parseProxycheckResponse(
        raw,
        signup.signup_ip,
        weights,
      );

      return {
        provider: "proxycheck",
        status: "success",
        lookupKey: signup.signup_ip,
        score: risk,
        response: raw,
        signals,
      };
    } catch (error) {
      return {
        provider: "proxycheck",
        status: "failed",
        lookupKey: signup.signup_ip,
        // The request URL carries the proxycheck API key, and fetch errors can
        // echo it back — never persist or surface an unscrubbed message.
        errorCode:
          error instanceof Error
            ? this.scrub(error.message).slice(0, 100)
            : "unknown_error",
        signals: [],
      };
    }
  }
}
