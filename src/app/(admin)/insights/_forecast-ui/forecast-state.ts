/**
 * forecast-state.ts — generic codec that serializes the simulator's lever state
 * so it can be dropped on the URL (`?fc=`) and reopened / shared later.
 *
 * Reward-agnostic: the assumptions object is an arbitrary record of numbers
 * (plus an optional `segmentMix` record). Decoding is DEFENSIVE — any garbage
 * (truncated param, old schema, hand-edited) returns `null` and the UI falls
 * back to the reward's defaults rather than throwing. The numeric-key set to
 * validate is supplied by the caller (built from the active config's levers +
 * the base volume keys) so a reward with extra levers round-trips cleanly.
 *
 * No engine math here — just (de)serialization of the lever state.
 */

import type { BaseAssumptions } from "../_forecast-engine";

/**
 * A generic assumptions object: numeric fields plus optional record-valued
 * levers (e.g. a `segmentMix`). The index signature's union covers both, so a
 * reward can carry any numeric lever and at most a few `Record<string,number>`
 * levers (segment mixes) without a bespoke type.
 */
export type AnyAssumptions = BaseAssumptions & {
  [key: string]: number | Record<string, number>;
};

export type ForecastUrlState = {
  scenarioId: string;
  /** Whether the secondary (what-if) comparison set is active. */
  showWhatifSet: boolean;
  assumptions: AnyAssumptions;
};

/** Version tag for the encoded blob, so a future format change is detectable. */
const STATE_VERSION = 1;

type EncodedShape = {
  v: number;
  s: ForecastUrlState;
};

/** The base numeric keys every reward's assumptions carry (validated always). */
const BASE_NUMERIC_KEYS: Array<keyof BaseAssumptions> = [
  "baselineClaimants",
  "baselinePeriodDays",
  "baselineClaimProbability",
  "depositsPerUserPerWindow",
  "claimProbability",
  "avgBonusUsd",
  "windowDays",
];

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
 * malformed, the wrong version, or fails the shape guard. `extraNumericKeys`
 * are the reward-specific lever keys to additionally require (from the active
 * config's levers).
 */
export function decodeForecastState(
  raw: string | null | undefined,
  extraNumericKeys: string[] = [],
): ForecastUrlState | null {
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
  if (!isForecastUrlState(s, extraNumericKeys)) return null;
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

function isForecastUrlState(x: unknown, extraNumericKeys: string[]): x is ForecastUrlState {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.scenarioId !== "string") return false;
  if (typeof o.showWhatifSet !== "boolean") return false;
  const a = o.assumptions;
  if (typeof a !== "object" || a === null) return false;
  const ao = a as Record<string, unknown>;
  const numericKeys = [...BASE_NUMERIC_KEYS, ...extraNumericKeys];
  for (const k of numericKeys) {
    if (!isFiniteNumber(ao[k])) return false;
  }
  // A segmentMix, when present, must be a plain object of numbers.
  if ("segmentMix" in ao && ao.segmentMix != null) {
    if (typeof ao.segmentMix !== "object") return false;
  }
  return true;
}
