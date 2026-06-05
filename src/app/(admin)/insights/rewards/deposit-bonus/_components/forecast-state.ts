/**
 * forecast-state.ts — serialize the simulator's full scenario config so it can
 * be dropped on the URL (`?fc=`) and reopened / shared later.
 *
 * The brief requires the scenario config be "serializable (URL or state) so it
 * can be saved/shared later". This is the URL codec: a compact, versioned,
 * URL-safe base64 of a plain JSON object. Decoding is defensive — any garbage
 * (truncated param, old schema, hand-edited) returns `null` and the UI falls
 * back to defaults rather than throwing.
 *
 * No engine math here — just (de)serialization of the lever state.
 */

import type { Assumptions } from "../_forecast";

export type ForecastUrlState = {
  scenarioId: string;
  showSplitCapSet: boolean;
  assumptions: Assumptions;
};

/** Version tag for the encoded blob, so a future format change is detectable. */
const STATE_VERSION = 1;

type EncodedShape = {
  v: number;
  s: ForecastUrlState;
};

/** URL-safe base64 (no `+`, `/`, `=`). Works in both browser & node (SSR). */
function toBase64Url(input: string): string {
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(input)))
      : Buffer.from(input, "utf-8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string | null {
  try {
    const b64 =
      input.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((input.length + 3) % 4);
    if (typeof atob === "function") {
      return decodeURIComponent(escape(atob(b64)));
    }
    return Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

export function encodeForecastState(state: ForecastUrlState): string {
  const payload: EncodedShape = { v: STATE_VERSION, s: state };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode a `?fc=` blob back into the lever state, or `null` if it is missing,
 * malformed, the wrong version, or fails the shape guard.
 */
export function decodeForecastState(raw: string | null | undefined): ForecastUrlState | null {
  if (!raw) return null;
  const json = fromBase64Url(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isEncodedShape(parsed) || parsed.v !== STATE_VERSION) return null;
  const s = parsed.s;
  if (!isForecastUrlState(s)) return null;
  return s;
}

// ─── Type guards (defensive — never trust the URL) ───────────────────

function isEncodedShape(x: unknown): x is EncodedShape {
  return (
    typeof x === "object" &&
    x !== null &&
    "v" in x &&
    typeof (x as { v: unknown }).v === "number" &&
    "s" in x
  );
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isForecastUrlState(x: unknown): x is ForecastUrlState {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.scenarioId !== "string") return false;
  if (typeof o.showSplitCapSet !== "boolean") return false;
  const a = o.assumptions;
  if (typeof a !== "object" || a === null) return false;
  const ao = a as Record<string, unknown>;
  const numericKeys: Array<keyof Assumptions> = [
    "baselineClaimants",
    "baselinePeriodDays",
    "baselineClaimProbability",
    "depositsPerUserPerWindow",
    "claimProbability",
    "avgBonusUsd",
    "breakageRate",
    "abuseShare",
    "abuseCaptureElasticity",
    "retentionUplift",
    "cannibalizationRate",
    "legitConversionSensitivity",
    "windowDays",
  ];
  for (const k of numericKeys) {
    if (!isFiniteNumber(ao[k])) return false;
  }
  if (typeof ao.segmentMix !== "object" || ao.segmentMix === null) return false;
  return true;
}
