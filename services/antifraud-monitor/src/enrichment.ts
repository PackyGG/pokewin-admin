import {
  FingerprintJsServerApiClient,
  Region,
} from "@fingerprintjs/fingerprintjs-pro-server-api";

import type { Config } from "./config.js";
import type { Signal, Signup } from "./types.js";

type JsonObject = Record<string, unknown>;

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
          points: 15,
        }],
      };
    }

    try {
      const event = await this.fingerprint.getEvent(
        signup.fingerprint_request_id,
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
        80,
      );
      add(
        truthy(products, "vpn", "data", "result"),
        "fingerprint_vpn",
        "VPN detected",
        "Fingerprint detected VPN use or a location mismatch.",
        20,
      );
      add(
        truthy(products, "proxy", "data", "result"),
        "fingerprint_proxy",
        "Proxy detected",
        "Fingerprint detected a public or residential proxy.",
        35,
      );
      add(
        truthy(products, "tor", "data", "result"),
        "fingerprint_tor",
        "Tor detected",
        "Fingerprint identified a Tor exit node.",
        65,
      );
      add(
        truthy(products, "incognito", "data", "result"),
        "fingerprint_incognito",
        "Private browsing",
        "The account was created in private/incognito mode.",
        10,
      );
      add(
        truthy(products, "tampering", "data", "result"),
        "fingerprint_tampering",
        "Browser tampering",
        "Fingerprint detected an anti-detect or tampered browser.",
        70,
      );
      add(
        truthy(products, "virtualMachine", "data", "result"),
        "fingerprint_virtual_machine",
        "Virtual machine",
        "The signup browser appears to run in a virtual machine.",
        25,
      );
      add(
        truthy(products, "highActivity", "data", "result"),
        "fingerprint_high_activity",
        "High-activity device",
        "The device is among the most active devices seen by Fingerprint.",
        45,
      );

      const suspectScore = Number(
        path(products, "suspectScore", "data", "result") ?? 0,
      );
      if (Number.isFinite(suspectScore) && suspectScore >= 20) {
        signals.push({
          key: "fingerprint_suspect_score",
          title: "Fingerprint suspect score",
          detail: `Fingerprint returned a suspect score of ${suspectScore}.`,
          points: Math.min(50, Math.round(suspectScore / 2)),
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
      const direct = raw[signup.signup_ip];
      const nested = object(raw.data)[signup.signup_ip];
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
      const type = String(
        detectionTypes.join(", ")
          || node.type
          || detections.type
          || detections.operator_type
          || "",
      ).toLowerCase();
      const signals: Signal[] = [];

      if (anonymous) {
        const points = /tor|proxy|compromised/.test(type) ? 55 : 25;
        signals.push({
          key: "proxycheck_anonymous",
          title: type ? `Anonymous IP: ${type}` : "Anonymous IP detected",
          detail: "proxycheck.io identified anonymized or proxy traffic.",
          points,
          payload: { type },
        });
      }
      if (Number.isFinite(risk) && risk >= 51) {
        signals.push({
          key: "proxycheck_risk",
          title: "High-risk IP",
          detail: `proxycheck.io returned a risk score of ${risk}.`,
          points: risk >= 76 ? 45 : 25,
          payload: {
            risk,
            asn: network.asn ?? node.asn,
            provider: network.provider ?? node.provider,
          },
        });
      }

      return {
        provider: "proxycheck",
        status: "success",
        lookupKey: signup.signup_ip,
        score: Number.isFinite(risk) ? risk : undefined,
        response: raw,
        signals,
      };
    } catch (error) {
      return {
        provider: "proxycheck",
        status: "failed",
        lookupKey: signup.signup_ip,
        errorCode:
          error instanceof Error ? error.message.slice(0, 100) : "unknown_error",
        signals: [],
      };
    }
  }
}
