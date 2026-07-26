import {
  FingerprintJsServerApiClient,
  Region,
} from "@fingerprintjs/fingerprintjs-pro-server-api";

import type { Config } from "./config.js";
import { SCORE_POINTS } from "./score-catalog.js";
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

export function parseProxycheckResponse(
  raw: JsonObject,
  signupIp: string,
): { risk: number; signals: Signal[] } {
  const direct = raw[signupIp];
  const nested = object(raw.data)[signupIp];
  const node = object(direct ?? nested);
  const detections = object(node.detections);
  const network = object(node.network);
  const risk = Number(
    detections.risk
      ?? node.risk
      ?? object(node.risk_score).score
      ?? raw.risk
      ?? 0,
  );
  const detectionTypes = [
    "proxy",
    "vpn",
    "tor",
    "compromised",
    "scraper",
    "hosting",
  ].filter((key) => detections[key] === true);
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
  const signals: Signal[] = [];

  if (positiveDetection) {
    const points = /tor|proxy|compromised/.test(type)
      ? SCORE_POINTS.proxycheckAnonymous.torProxyCompromised
      : SCORE_POINTS.proxycheckAnonymous.lowerRisk;
    signals.push({
      key: "proxycheck_anonymous",
      title: type ? `Anonymous IP: ${type}` : "Anonymous IP detected",
      detail: "proxycheck.io identified anonymized or proxy traffic.",
      points,
      payload: { type, detectionTypes },
    });
  }
  if (
    Number.isFinite(risk) &&
    risk >= SCORE_POINTS.proxycheckRisk.threshold
  ) {
    signals.push({
      key: "proxycheck_risk",
      title: "High-risk IP",
      detail: `proxycheck.io returned a risk score of ${risk}.`,
      points:
        risk >= SCORE_POINTS.proxycheckRisk.highThreshold
          ? SCORE_POINTS.proxycheckRisk.high
          : SCORE_POINTS.proxycheckRisk.medium,
      payload: {
        risk,
        asn: network.asn ?? node.asn,
        provider: network.provider ?? node.provider,
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
    ].reduce(
      (message, secret) =>
        secret ? message.replaceAll(secret, "[redacted]") : message,
      value,
    );
  }

  async fingerprintCheck(signup: Signup): Promise<EnrichmentResult> {
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
      const products = object(raw.products);
      const signals: Signal[] = [];

      const add = (
        hit: boolean,
        key: string,
        title: string,
        detail: string,
        points: number,
      ) => {
        if (hit) signals.push({ key, title, detail, points });
      };

      add(
        path(products, "botd", "data", "bot", "result") === "bad",
        "fingerprint_bad_bot",
        "Bad bot detected",
        "Fingerprint identified browser automation or a malicious bot.",
        SCORE_POINTS.fingerprintBadBot,
      );
      add(
        truthy(products, "vpn", "data", "result"),
        "fingerprint_vpn",
        "VPN detected",
        "Fingerprint detected VPN use or a location mismatch.",
        SCORE_POINTS.fingerprintVpn,
      );
      add(
        truthy(products, "proxy", "data", "result"),
        "fingerprint_proxy",
        "Proxy detected",
        "Fingerprint detected a public or residential proxy.",
        SCORE_POINTS.fingerprintProxy,
      );
      add(
        truthy(products, "tor", "data", "result"),
        "fingerprint_tor",
        "Tor detected",
        "Fingerprint identified a Tor exit node.",
        SCORE_POINTS.fingerprintTor,
      );
      add(
        truthy(products, "incognito", "data", "result"),
        "fingerprint_incognito",
        "Private browsing",
        "The account was created in private/incognito mode.",
        SCORE_POINTS.fingerprintIncognito,
      );
      add(
        truthy(products, "tampering", "data", "result"),
        "fingerprint_tampering",
        "Browser tampering",
        "Fingerprint detected an anti-detect or tampered browser.",
        SCORE_POINTS.fingerprintTampering,
      );
      add(
        truthy(products, "virtualMachine", "data", "result"),
        "fingerprint_virtual_machine",
        "Virtual machine",
        "The signup browser appears to run in a virtual machine.",
        SCORE_POINTS.fingerprintVirtualMachine,
      );
      add(
        truthy(products, "highActivity", "data", "result"),
        "fingerprint_high_activity",
        "High-activity device",
        "The device is among the most active devices seen by Fingerprint.",
        SCORE_POINTS.fingerprintHighActivity,
      );

      const suspectScore = Number(
        path(products, "suspectScore", "data", "result") ?? 0,
      );
      if (
        Number.isFinite(suspectScore) &&
        suspectScore >= SCORE_POINTS.fingerprintSuspectScore.threshold
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
        provider: "fingerprint",
        status: "success",
        lookupKey: signup.fingerprint_request_id,
        requestId: signup.fingerprint_request_id,
        score: Number.isFinite(suspectScore) ? suspectScore : undefined,
        response: raw,
        signals,
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

  async proxycheck(signup: Signup): Promise<EnrichmentResult> {
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

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const raw = object(await response.json());
      const { risk, signals } = parseProxycheckResponse(raw, signup.signup_ip);

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
