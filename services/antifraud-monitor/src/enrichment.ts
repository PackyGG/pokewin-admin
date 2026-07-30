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
import {
  classifyProviderFailure,
  PROVIDER_CONTRACTS,
  type ProviderCompleteness,
  type ProviderFailureKind,
  type SignupProvider,
} from "./provider-contracts.js";
import type { Signal, Signup } from "./types.js";

type JsonObject = Record<string, unknown>;
type ProviderProvenance = {
  endpoint: string;
  method: string;
  source: "live" | "cache" | "input";
  independent: true;
  tag?: ProxycheckTag;
};

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
  const normalized = object(raw.result);
  if (Object.keys(normalized).length > 0) return normalized;
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
  provider: SignupProvider;
  status: "success" | "skipped" | "failed";
  lookupKey: string;
  requestId?: string;
  score?: number;
  nativeScore?: number;
  nativeRank?: string;
  nativeConfidence?: number;
  completeness: ProviderCompleteness;
  providerModel: string;
  providerVersion: string;
  provenance: ProviderProvenance;
  failureKind?: ProviderFailureKind;
  response?: JsonObject;
  errorCode?: string;
  signals: Signal[];
};

export type ProxycheckTag = "signup" | "fiat-eligibility";

export function providerContractMetadata(
  provider: SignupProvider,
  source: ProviderProvenance["source"],
  completeness: ProviderCompleteness,
  extras: {
    tag?: ProxycheckTag;
    nativeScore?: number;
    nativeRank?: string;
    nativeConfidence?: number;
    errorCode?: string;
  } = {},
): Pick<
  EnrichmentResult,
  | "providerModel"
  | "providerVersion"
  | "provenance"
  | "completeness"
  | "nativeScore"
  | "nativeRank"
  | "nativeConfidence"
  | "failureKind"
> {
  const contract = PROVIDER_CONTRACTS[provider];
  return {
    providerModel: contract.model,
    providerVersion: contract.version,
    completeness,
    provenance: {
      endpoint: contract.endpoint,
      method: contract.method,
      source,
      independent: true,
      ...(extras.tag ? { tag: extras.tag } : {}),
    },
    ...(extras.nativeScore !== undefined
      ? { nativeScore: extras.nativeScore }
      : {}),
    ...(extras.nativeRank !== undefined
      ? { nativeRank: extras.nativeRank }
      : {}),
    ...(extras.nativeConfidence !== undefined
      ? { nativeConfidence: extras.nativeConfidence }
      : {}),
    ...(extras.errorCode
      ? { failureKind: classifyProviderFailure(extras.errorCode) }
      : {}),
  };
}

function boundedSanitizedObject(
  value: unknown,
  blockedKeys: ReadonlySet<string>,
  depth = 0,
): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) =>
      boundedSanitizedObject(entry, blockedKeys, depth + 1)
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(([key]) => !blockedKeys.has(key.toLowerCase()))
      .slice(0, 150)
      .map(([key, entry]) => [
        key,
        boundedSanitizedObject(entry, blockedKeys, depth + 1),
      ]),
  );
}

export function sanitizeFingerprintResponse(raw: JsonObject): JsonObject {
  const products = object(raw.products);
  const allowedProducts = [
    "identification",
    "botd",
    "vpn",
    "proxy",
    "tor",
    "ipInfo",
    "ipBlocklist",
    "incognito",
    "tampering",
    "virtualMachine",
    "highActivity",
    "privacySettings",
    "developerTools",
    "rareDevice",
    "velocity",
    "suspectScore",
    "rootApps",
    "emulator",
    "clonedApp",
    "jailbroken",
    "frida",
    "locationSpoofing",
    "mitmAttack",
    "factoryReset",
    "proximity",
  ];
  const blocked = new Set([
    "ip",
    "address",
    "linkedid",
    "visitorid",
    "requestid",
    "id",
    "latitude",
    "longitude",
  ]);
  return {
    evidence_contract: "fingerprint-pro-plus-sanitized-v1",
    products: Object.fromEntries(
      allowedProducts
        .filter((key) => products[key] !== undefined)
        .map((key) => [
          key,
          boundedSanitizedObject(products[key], blocked),
        ]),
    ),
  };
}

export function sanitizeProxycheckResponse(
  raw: JsonObject,
  signupIp: string,
): JsonObject {
  const node = proxycheckResultNode(raw, signupIp);
  const allowed = [
    "last_updated",
    "risk",
    "risk_score",
    "proxy",
    "anonymous",
    "type",
    "asn",
    "provider",
    "detections",
    "network",
    "location",
    "device_estimate",
    "detection_history",
    "attack_history",
    "operator",
  ];
  const blocked = new Set([
    "ip",
    "address",
    "hostname",
    "url",
    "city",
    "latitude",
    "longitude",
    "postal",
    "postal_code",
  ]);
  return {
    evidence_contract: "proxycheck-v3-sanitized-v1",
    status: raw.status,
    result: Object.fromEntries(
      allowed
        .filter((key) => node[key] !== undefined)
        .map((key) => [
          key,
          boundedSanitizedObject(node[key], blocked),
        ]),
    ),
  };
}

export function sanitizeAbstractIpResponse(raw: JsonObject): JsonObject {
  const location = object(raw.location);
  return {
    evidence_contract: "abstract-ip-sanitized-v1",
    security: object(raw.security),
    asn: object(raw.asn),
    company: object(raw.company),
    location: {
      country_code: location.country_code,
      region: location.region,
    },
  };
}

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

export function parseAbstractIpResponse(
  raw: JsonObject,
  signup: Signup,
  weights: ScoreWeights = defaultScoreWeights(),
): { score: number; signals: Signal[] } {
  const points = scorePoints(weights).abstractIp;
  const security = object(raw.security);
  const asn = object(raw.asn);
  const company = object(raw.company);
  const location = object(raw.location);
  const countryCode = stringValue(location.country_code)?.toUpperCase();
  const signupCountryCode = signup.country_code?.trim().toUpperCase() || null;
  const evidence = signalPayload({
    asn: asn.asn,
    asnName: asn.name,
    asnDomain: asn.domain,
    asnType: asn.type,
    companyName: company.name,
    companyDomain: company.domain,
    companyType: company.type,
    countryCode,
    region: location.region,
    city: location.city,
  });
  const signals: Signal[] = [];
  const add = (
    hit: boolean,
    key: string,
    title: string,
    detail: string,
    score: number,
  ) => {
    if (!hit) return;
    signals.push({ key, title, detail, points: score, payload: evidence });
  };

  add(
    security.is_vpn === true,
    "abstract_ip_vpn",
    "Abstract: VPN detected",
    "Abstract IP Intelligence classified the signup IP as a VPN.",
    points.vpn,
  );
  add(
    security.is_proxy === true,
    "abstract_ip_proxy",
    "Abstract: proxy detected",
    "Abstract IP Intelligence classified the signup IP as a proxy.",
    points.proxy,
  );
  add(
    security.is_tor === true,
    "abstract_ip_tor",
    "Abstract: Tor detected",
    "Abstract IP Intelligence classified the signup IP as a Tor address.",
    points.tor,
  );
  add(
    security.is_hosting === true,
    "abstract_ip_hosting",
    "Abstract: hosting network",
    "Abstract IP Intelligence classified the signup IP as hosting infrastructure.",
    points.hosting,
  );
  add(
    security.is_relay === true,
    "abstract_ip_relay",
    "Abstract: relay detected",
    "Abstract IP Intelligence classified the signup IP as a relay.",
    points.relay,
  );
  add(
    security.is_abuse === true,
    "abstract_ip_abuse",
    "Abstract: abusive IP",
    "Abstract IP Intelligence reports abuse history for the signup IP.",
    points.abuse,
  );
  add(
    Boolean(
      countryCode
      && signupCountryCode
      && countryCode !== signupCountryCode,
    ),
    "abstract_ip_country_mismatch",
    "Abstract: signup country mismatch",
    `Abstract located the signup IP in ${countryCode}, while the account recorded ${signupCountryCode}.`,
    points.countryMismatch,
  );

  return {
    score: signals.reduce((total, signal) => total + signal.points, 0),
    signals,
  };
}

function emailRiskLevel(value: unknown): "low" | "medium" | "high" | null {
  const normalized = stringValue(value)?.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : null;
}

export function parseAbstractEmailResponse(
  raw: JsonObject,
  weights: ScoreWeights = defaultScoreWeights(),
): { score: number; signals: Signal[] } {
  const points = scorePoints(weights).abstractEmail;
  const deliverability = object(raw.email_deliverability);
  const quality = object(raw.email_quality);
  const domain = object(raw.email_domain);
  const risk = object(raw.email_risk);
  const status = stringValue(deliverability.status)?.toLowerCase();
  const statusDetail = stringValue(deliverability.status_detail);
  const qualityScore = numberValue(quality.score);
  const emailAddressMinimumAge = numberValue(quality.minimum_age);
  const domainAge = numberValue(domain.domain_age);
  const addressRisk = emailRiskLevel(risk.address_risk_status);
  const domainRisk = emailRiskLevel(risk.domain_risk_status);
  const evidence = signalPayload({
    deliverability: status,
    statusDetail,
    qualityScore,
    domain: domain.domain,
    emailAddressMinimumAgeDays: emailAddressMinimumAge,
    domainAgeDays: domainAge,
    addressRisk,
    domainRisk,
    suggestedCorrection: raw.suggested_correction,
  });
  const signals: Signal[] = [];
  const add = (
    hit: boolean,
    key: string,
    title: string,
    detail: string,
    score: number,
  ) => {
    if (!hit) return;
    signals.push({ key, title, detail, points: score, payload: evidence });
  };

  add(
    quality.is_catchall === true,
    "abstract_email_catchall",
    "Catch-all email domain",
    "Abstract reports that this domain accepts mail for any mailbox. The account requires containment and review.",
    points.catchall,
  );
  add(
    status === "undeliverable",
    "abstract_email_undeliverable",
    "Undeliverable signup email",
    `Abstract reports the signup email as undeliverable${statusDetail ? ` (${statusDetail})` : ""}.`,
    points.undeliverable,
  );
  add(
    status === "unknown",
    "abstract_email_unknown_deliverability",
    "Unknown email deliverability",
    `Abstract could not confirm email deliverability${statusDetail ? ` (${statusDetail})` : ""}.`,
    points.unknownDeliverability,
  );
  add(
    deliverability.is_smtp_valid === false
      || deliverability.is_mx_valid === false,
    "abstract_email_invalid_smtp",
    "Invalid email routing",
    "Abstract could not validate the mailbox SMTP path or domain MX records.",
    points.invalidSmtp,
  );
  add(
    quality.is_disposable === true,
    "abstract_email_disposable",
    "Disposable signup email",
    "Abstract classified the signup email provider as disposable.",
    points.disposable,
  );
  add(
    quality.is_username_suspicious === true,
    "abstract_email_suspicious_username",
    "Suspicious email username",
    "Abstract classified the email username as suspicious or auto-generated.",
    points.suspiciousUsername,
  );
  add(
    addressRisk === "high" || domainRisk === "high",
    "abstract_email_high_risk",
    "High-risk signup email",
    "Abstract returned a high address or domain risk classification.",
    points.highRisk,
  );
  add(
    addressRisk === "medium" || domainRisk === "medium",
    "abstract_email_medium_risk",
    "Medium-risk signup email",
    "Abstract returned a medium address or domain risk classification.",
    points.mediumRisk,
  );
  add(
    domain.is_risky_tld === true,
    "abstract_email_risky_tld",
    "Risky email top-level domain",
    "Abstract classified the email domain suffix as risky.",
    points.riskyTld,
  );
  if (qualityScore !== undefined && qualityScore < 0.5) {
    add(
      true,
      "abstract_email_low_quality",
      "Low-quality signup email",
      `Abstract returned an email quality score of ${qualityScore.toFixed(2)}.`,
      points.lowQuality,
    );
  }
  if (domainAge !== undefined && domainAge >= 0 && domainAge < 30) {
    add(
      true,
      "abstract_email_new_domain",
      "New email domain",
      `Abstract reports that the email domain is only ${Math.round(domainAge)} days old.`,
      points.newDomain,
    );
  }

  return {
    score: signals.reduce((total, signal) => total + signal.points, 0),
    signals,
  };
}

export function sanitizeAbstractEmailResponse(raw: JsonObject): JsonObject {
  const deliverability = object(raw.email_deliverability);
  const quality = object(raw.email_quality);
  const domain = object(raw.email_domain);
  const risk = object(raw.email_risk);
  const breaches = object(raw.email_breaches);
  return {
    evidence_contract: "abstract-email-sanitized-v1",
    email_deliverability: {
      status: deliverability.status,
      status_detail: deliverability.status_detail,
      is_format_valid: deliverability.is_format_valid,
      is_smtp_valid: deliverability.is_smtp_valid,
      is_mx_valid: deliverability.is_mx_valid,
      mx_record_count: Array.isArray(deliverability.mx_records)
        ? deliverability.mx_records.length
        : 0,
    },
    email_quality: {
      score: quality.score,
      is_free_email: quality.is_free_email,
      is_username_suspicious: quality.is_username_suspicious,
      is_disposable: quality.is_disposable,
      is_catchall: quality.is_catchall,
      is_subaddress: quality.is_subaddress,
      is_role: quality.is_role,
      is_dmarc_enforced: quality.is_dmarc_enforced,
      is_spf_strict: quality.is_spf_strict,
      minimum_age: quality.minimum_age,
    },
    email_domain: {
      domain: domain.domain,
      domain_age: domain.domain_age,
      is_live_site: domain.is_live_site,
      date_registered: domain.date_registered,
      is_risky_tld: domain.is_risky_tld,
    },
    email_risk: {
      address_risk_status: risk.address_risk_status,
      domain_risk_status: risk.domain_risk_status,
    },
    email_breaches: {
      total_breaches: breaches.total_breaches,
      date_first_breached: breaches.date_first_breached,
      date_last_breached: breaches.date_last_breached,
    },
  };
}

type OpportifyLevel = "lowest" | "low" | "medium" | "high" | "highest";

function opportifyLevel(value: unknown): OpportifyLevel | undefined {
  const normalized = stringValue(value)?.trim().toLowerCase();
  return normalized === "lowest"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "highest"
    ? normalized
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function compactObject(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) =>
      value !== undefined && value !== null && value !== ""),
  );
}

function sanitizedOpportifyResponse(raw: JsonObject): JsonObject {
  const sources = object(raw.sources);
  const email = object(sources.email);
  const addressSignals = object(email.addressSignals);
  const emailDns = object(email.emailDNS);
  const emailDomain = object(email.domain);
  const emailRisk = object(email.riskReport);
  const ip = object(sources.ip);
  const ipGeo = object(ip.geo);
  const whois = object(ip.whois);
  const asn = object(whois.asn);
  const organization = object(whois.organization);
  const trustedProvider = object(ip.trustedProvider);
  const blocklisted = object(ip.blocklisted);
  const ipRisk = object(ip.riskReport);
  const content = object(sources.content);
  const velocity = object(sources.velocity);
  const geo = object(sources.geo);
  const session = object(sources.session);

  return {
    score: raw.score,
    level: raw.level,
    factors: stringArray(raw.factors).slice(0, 100),
    sources: compactObject({
      email: Object.keys(email).length === 0
        ? undefined
        : compactObject({
            emailProvider: email.emailProvider,
            emailType: email.emailType,
            isDeliverable: email.isDeliverable,
            isCatchAll: email.isCatchAll,
            isMailboxFull: email.isMailboxFull,
            isReachable: email.isReachable,
            isFormatValid: email.isFormatValid,
            addressSignals: compactObject({
              tagDetected: addressSignals.tagDetected,
              isRoleAddress: addressSignals.isRoleAddress,
              roleType: addressSignals.roleType,
              isNoReply: addressSignals.isNoReply,
              noReplyPattern: addressSignals.noReplyPattern,
            }),
            emailDNS: compactObject({
              mxCount: Array.isArray(emailDns.mx) ? emailDns.mx.length : 0,
              spfValid: emailDns.spfValid,
              dkimConfigured: emailDns.dkimConfigured,
              dmarcValid: emailDns.dmarcValid,
              mxRelay: emailDns.mxRelay,
              mxRelayCategory: emailDns.mxRelayCategory,
            }),
            riskReport: compactObject({
              score: emailRisk.score,
              level: emailRisk.level,
              baseAnalysis: stringArray(emailRisk.baseAnalysis).slice(0, 50),
            }),
            domain: compactObject({
              name: emailDomain.name,
              enrichmentAvailable: emailDomain.enrichmentAvailable,
              creationDate: emailDomain.creationDate,
              expirationDate: emailDomain.expirationDate,
              updatedDate: emailDomain.updatedDate,
              ageYears: emailDomain.ageYears,
              registrar: emailDomain.registrar,
              isBlockListed: emailDomain.isBlockListed,
              mtaStsStatus: emailDomain.mtaStsStatus,
              bimiStatus: emailDomain.bimiStatus,
              hasVMC: emailDomain.hasVMC,
              aRecordValid: emailDomain.aRecordValid,
              sslValid: emailDomain.sslValid,
            }),
          }),
      ip: Object.keys(ip).length === 0
        ? undefined
        : compactObject({
            ipType: ip.ipType,
            ipCidr: ip.ipCidr,
            connectionType: ip.connectionType,
            hostReverse: ip.hostReverse,
            geo: compactObject({
              continent: ipGeo.continent,
              countryCode: ipGeo.countryCode,
              countryName: ipGeo.countryName,
              city: ipGeo.city,
              region: ipGeo.region,
              timezone: ipGeo.timezone,
            }),
            network: compactObject({
              asn: asn.asn ?? asn.number,
              asName: asn.name,
              asDescription: asn.description,
              asCountry: asn.countryCode ?? asn.country,
              organization: organization.name,
              organizationType: organization.type,
              organizationCountry:
                organization.countryCode ?? organization.country,
            }),
            trustedProvider: compactObject({
              isKnownProvider: trustedProvider.isKnownProvider,
              provider: trustedProvider.provider,
              providerType: trustedProvider.providerType,
              description: trustedProvider.description,
            }),
            blocklisted: compactObject({
              isBlockListed: blocklisted.isBlockListed,
              sources: blocklisted.sources,
              activeReports: blocklisted.activeReports,
              lastDetected: blocklisted.lastDetected,
            }),
            riskReport: compactObject({
              score: ipRisk.score,
              level: ipRisk.level,
              baseAnalysis: stringArray(ipRisk.baseAnalysis).slice(0, 50),
            }),
          }),
      content: Object.keys(content).length === 0 ? undefined : content,
      velocity: Object.keys(velocity).length === 0 ? undefined : velocity,
      geo: Object.keys(geo).length === 0 ? undefined : geo,
      session: Object.keys(session).length === 0
        ? undefined
        : compactObject({
            tokenAge: session.tokenAge,
            tokenValid: session.tokenValid,
            detections: Array.isArray(session.detections)
              ? session.detections.slice(0, 100)
              : undefined,
            score: session.score,
            level: session.level,
            factors: stringArray(session.factors).slice(0, 50),
            eventCount: session.eventCount,
          }),
    }),
  };
}

function sourceRiskSummary(source: JsonObject): {
  score?: number;
  level?: OpportifyLevel;
  factors: string[];
} {
  const risk = object(source.riskReport);
  return {
    score: numberValue(risk.score),
    level: opportifyLevel(risk.level),
    factors: stringArray(risk.baseAnalysis).slice(0, 50),
  };
}

export function parseOpportifyResponse(
  raw: JsonObject,
  weights: ScoreWeights = defaultScoreWeights(),
): { score: number; level: OpportifyLevel; response: JsonObject; signals: Signal[] } {
  const response = sanitizedOpportifyResponse(raw);
  const score = numberValue(response.score);
  const level = opportifyLevel(response.level);
  if (score === undefined || score < 200 || score > 1_000 || !level) {
    throw new Error("invalid_response");
  }

  const points = scorePoints(weights).opportifyRisk;
  const scoringPoints =
    level === "highest"
      ? points.highest
      : level === "high"
        ? points.high
        : level === "medium"
          ? points.medium
          : 0;
  const signals: Signal[] = [];
  if (scoringPoints !== 0) {
    signals.push({
      key: "opportify_risk",
      title: `Opportify ${level} risk`,
      detail: `Opportify returned a composite signup fraud score of ${Math.round(score)} (${level}).`,
      points: scoringPoints,
      payload: {
        providerScore: score,
        providerLevel: level,
        factors: stringArray(response.factors).slice(0, 30),
      },
    });
  }

  const sources = object(response.sources);
  const email = object(sources.email);
  if (Object.keys(email).length > 0) {
    const risk = sourceRiskSummary(email);
    signals.push({
      key: "opportify_email_evidence",
      title: "Opportify email intelligence",
      detail: [
        stringValue(email.emailType) ?? "unknown type",
        `deliverable ${String(email.isDeliverable ?? "unknown")}`,
        email.isCatchAll === true ? "catch-all" : null,
        email.isMailboxFull === true ? "mailbox full" : null,
        risk.level ? `${risk.level} risk` : null,
      ].filter(Boolean).join(" · "),
      points: 0,
      payload: email,
    });
  }

  const ip = object(sources.ip);
  if (Object.keys(ip).length > 0) {
    const risk = sourceRiskSummary(ip);
    const blocklisted = object(ip.blocklisted);
    const trusted = object(ip.trustedProvider);
    const ipGeo = object(ip.geo);
    signals.push({
      key: "opportify_ip_evidence",
      title: "Opportify IP intelligence",
      detail: [
        stringValue(ip.connectionType) ?? "unknown connection",
        stringValue(ipGeo.countryCode),
        blocklisted.isBlockListed === true ? "blocklisted" : null,
        trusted.isKnownProvider === true ? "trusted provider" : null,
        risk.level ? `${risk.level} risk` : null,
      ].filter(Boolean).join(" · "),
      points: 0,
      payload: ip,
    });
  }

  const velocity = object(sources.velocity);
  if (Object.keys(velocity).length > 0) {
    signals.push({
      key: "opportify_velocity_evidence",
      title: "Opportify submission velocity",
      detail: velocity.anomaly === true
        ? "Opportify detected anomalous signup frequency."
        : "Opportify returned email and IP submission-frequency windows.",
      points: 0,
      payload: velocity,
    });
  }

  const geo = object(sources.geo);
  if (Object.keys(geo).length > 0) {
    signals.push({
      key: "opportify_geo_evidence",
      title: "Opportify geographic consistency",
      detail: geo.consistent === false
        ? "Opportify found inconsistent declared, email-domain, or IP countries."
        : "Opportify found the available geographic signals consistent.",
      points: 0,
      payload: geo,
    });
  }

  const content = object(sources.content);
  if (Object.keys(content).length > 0) {
    const names = object(content.names);
    const risk = sourceRiskSummary(content);
    signals.push({
      key: "opportify_content_evidence",
      title: "Opportify username analysis",
      detail: names.isGibberish === true
        ? "Opportify classified the signup name or username as gibberish."
        : risk.level
          ? `Opportify returned ${risk.level} username-content risk.`
          : "Opportify analyzed the signup name and username.",
      points: 0,
      payload: content,
    });
  }

  return { score, level, response, signals };
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
      this.config.ABSTRACT_IP_INTELLIGENCE_API_KEY,
      this.config.ABSTRACT_EMAIL_REPUTATION_API_KEY,
      this.config.OPPORTIFY_API_KEY,
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

  private providerErrorCode(error: unknown): string {
    if (!(error instanceof Error)) return "unknown_error";
    const candidate = error as Error & {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    const status = numberValue(candidate.status ?? candidate.statusCode);
    const code = stringValue(candidate.code);
    const detail = [
      status ? `http_${status}` : null,
      code,
      error.name,
      error.message,
    ].filter((value): value is string => Boolean(value)).join(":");
    return this.scrub(detail || "unknown_error").slice(0, 100);
  }

  async fingerprintCheck(
    signup: Signup,
    weights: ScoreWeights = defaultScoreWeights(),
  ): Promise<EnrichmentResult> {
    const SCORE_POINTS = scorePoints(weights);
    if (!signup.fingerprint_request_id) {
      const errorCode = "missing_request_id";
      return {
        provider: "fingerprint",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode,
        ...providerContractMetadata("fingerprint", "input", "unknown", {
          errorCode,
        }),
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
      if (
        Object.keys(
          object(path(raw, "products", "identification", "data")),
        ).length === 0
      ) {
        throw new Error("invalid_response");
      }
      const parsed = parseFingerprintResponse(raw, signup, weights);
      const nativeConfidence =
        numberValue(path(raw, "products", "identification", "data", "confidence", "score"))
        ?? signup.fingerprint_confidence
        ?? undefined;

      return {
        provider: "fingerprint",
        status: "success",
        lookupKey: signup.fingerprint_request_id,
        requestId: signup.fingerprint_request_id,
        score: parsed.score,
        ...providerContractMetadata("fingerprint", "live", "complete", {
          nativeScore: parsed.score,
          nativeConfidence,
        }),
        response: sanitizeFingerprintResponse(raw),
        signals: parsed.signals,
      };
    } catch (error) {
      const errorCode = this.providerErrorCode(error);
      return {
        provider: "fingerprint",
        status: "failed",
        lookupKey: signup.fingerprint_request_id,
        requestId: signup.fingerprint_request_id,
        errorCode,
        ...providerContractMetadata("fingerprint", "live", "unknown", {
          errorCode,
        }),
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
      const errorCode = "missing_ip";
      return {
        provider: "proxycheck",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode,
        ...providerContractMetadata("proxycheck", "input", "unknown", {
          tag,
          errorCode,
        }),
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
      const nativeConfidence = numberValue(
        path(resultNode, "detections", "confidence"),
      );

      return {
        provider: "proxycheck",
        status: "success",
        lookupKey: signup.signup_ip,
        score: risk,
        ...providerContractMetadata("proxycheck", "live", "complete", {
          tag,
          nativeScore: risk,
          nativeConfidence,
        }),
        response: sanitizeProxycheckResponse(raw, signup.signup_ip),
        signals,
      };
    } catch (error) {
      const errorCode = this.providerErrorCode(error);
      return {
        provider: "proxycheck",
        status: "failed",
        lookupKey: signup.signup_ip,
        // The request URL carries the proxycheck API key, and fetch errors can
        // echo it back — never persist or surface an unscrubbed message.
        errorCode,
        ...providerContractMetadata("proxycheck", "live", "unknown", {
          tag,
          errorCode,
        }),
        signals: [],
      };
    }
  }

  async abstractIpCheck(
    signup: Signup,
    weights: ScoreWeights = defaultScoreWeights(),
  ): Promise<EnrichmentResult> {
    if (!signup.signup_ip) {
      const errorCode = "missing_ip";
      return {
        provider: "abstract_ip",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode,
        ...providerContractMetadata("abstract_ip", "input", "unknown", {
          errorCode,
        }),
        signals: [],
      };
    }

    const url = new URL("https://ip-intelligence.abstractapi.com/v1/");
    url.searchParams.set(
      "api_key",
      this.config.ABSTRACT_IP_INTELLIGENCE_API_KEY,
    );
    url.searchParams.set("ip_address", signup.signup_ip);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const raw = object(await response.json());
      if (
        canonicalIp(raw.ip_address) !== canonicalIp(signup.signup_ip)
        || Object.keys(object(raw.security)).length === 0
      ) {
        throw new Error("invalid_response");
      }
      const parsed = parseAbstractIpResponse(raw, signup, weights);
      return {
        provider: "abstract_ip",
        status: "success",
        lookupKey: signup.signup_ip,
        score: parsed.score,
        ...providerContractMetadata("abstract_ip", "live", "complete"),
        response: sanitizeAbstractIpResponse(raw),
        signals: parsed.signals,
      };
    } catch (error) {
      const errorCode = this.providerErrorCode(error);
      return {
        provider: "abstract_ip",
        status: "failed",
        lookupKey: signup.signup_ip,
        errorCode,
        ...providerContractMetadata("abstract_ip", "live", "unknown", {
          errorCode,
        }),
        signals: [],
      };
    }
  }

  async abstractEmailCheck(
    signup: Signup,
    weights: ScoreWeights = defaultScoreWeights(),
  ): Promise<EnrichmentResult> {
    const email = signup.email?.trim().toLowerCase();
    if (!email) {
      const errorCode = "missing_email";
      return {
        provider: "abstract_email",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode,
        ...providerContractMetadata("abstract_email", "input", "unknown", {
          errorCode,
        }),
        signals: [],
      };
    }

    try {
      const response = await fetch(
        "https://emailreputation.abstractapi.com/v1/",
        {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: {
            accept: "application/json",
            authorization:
              `Bearer ${this.config.ABSTRACT_EMAIL_REPUTATION_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email }),
        },
      );
      if (!response.ok) throw new Error(`http_${response.status}`);
      const raw = object(await response.json());
      if (
        stringValue(raw.email_address)?.trim().toLowerCase() !== email
        || Object.keys(object(raw.email_deliverability)).length === 0
        || Object.keys(object(raw.email_quality)).length === 0
      ) {
        throw new Error("invalid_response");
      }
      const sanitized = sanitizeAbstractEmailResponse(raw);
      const parsed = parseAbstractEmailResponse(sanitized, weights);
      const quality = object(sanitized.email_quality);
      const risk = object(sanitized.email_risk);
      const addressRank = emailRiskLevel(risk.address_risk_status);
      const domainRank = emailRiskLevel(risk.domain_risk_status);
      const nativeRank =
        addressRank === "high" || domainRank === "high"
          ? "high"
          : addressRank === "medium" || domainRank === "medium"
            ? "medium"
            : addressRank ?? domainRank ?? undefined;
      return {
        provider: "abstract_email",
        status: "success",
        lookupKey: email,
        score: parsed.score,
        ...providerContractMetadata("abstract_email", "live", "complete", {
          nativeScore: numberValue(quality.score),
          nativeRank,
        }),
        response: sanitized,
        signals: parsed.signals,
      };
    } catch (error) {
      const errorCode = this.providerErrorCode(error);
      return {
        provider: "abstract_email",
        status: "failed",
        lookupKey: email,
        errorCode,
        ...providerContractMetadata("abstract_email", "live", "unknown", {
          errorCode,
        }),
        signals: [],
      };
    }
  }

  async opportifyCheck(
    signup: Signup,
    weights: ScoreWeights = defaultScoreWeights(),
  ): Promise<EnrichmentResult> {
    const email = signup.email?.trim().toLowerCase() || undefined;
    const userIp = canonicalIp(signup.signup_ip);
    if (!email && !userIp) {
      const errorCode = "missing_email_and_ip";
      return {
        provider: "opportify",
        status: "skipped",
        lookupKey: `user:${signup.id}`,
        errorCode,
        ...providerContractMetadata("opportify", "input", "unknown", {
          errorCode,
        }),
        signals: [],
      };
    }

    const body = compactObject({
      email,
      userIp,
      fullName: signup.name?.trim().slice(0, 200),
      username: signup.username?.trim().slice(0, 200),
      city: signup.city?.trim().slice(0, 200),
      region: signup.state?.trim().slice(0, 200),
      country: signup.country_code?.trim().toUpperCase().slice(0, 2),
      submissionType: "registration",
    });

    try {
      const providerResponse = await fetch(
        "https://api.opportify.ai/intel/v1/fraud/analyze",
        {
          method: "POST",
          signal: AbortSignal.timeout(8_000),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-opportify-token": this.config.OPPORTIFY_API_KEY,
          },
          body: JSON.stringify(body),
        },
      );
      if (!providerResponse.ok) {
        throw new Error(`http_${providerResponse.status}`);
      }
      const text = await providerResponse.text();
      if (text.length > 512_000) throw new Error("response_too_large");
      const raw = object(JSON.parse(text));
      const parsed = parseOpportifyResponse(raw, weights);
      const sources = object(parsed.response.sources);
      const expectedSources = [
        email ? "email" : null,
        userIp ? "ip" : null,
        signup.name || signup.username ? "content" : null,
      ].filter((value): value is string => Boolean(value));
      const missingSources = expectedSources.filter(
        (source) => Object.keys(object(sources[source])).length === 0,
      );
      const completeness: ProviderCompleteness =
        missingSources.length === 0 ? "complete" : "partial";
      return {
        provider: "opportify",
        status: "success",
        lookupKey: `user:${signup.id}`,
        score: parsed.score,
        ...providerContractMetadata("opportify", "live", completeness, {
          nativeScore: parsed.score,
          nativeRank: parsed.level,
        }),
        response: parsed.response,
        signals: parsed.signals,
      };
    } catch (error) {
      const errorCode = this.providerErrorCode(error);
      return {
        provider: "opportify",
        status: "failed",
        lookupKey: `user:${signup.id}`,
        errorCode,
        ...providerContractMetadata("opportify", "live", "unknown", {
          errorCode,
        }),
        signals: [],
      };
    }
  }
}
