import { getAdminSetting } from "@/lib/admin-settings";
import type { PackRisk } from "@/app/(admin)/insights/edge-calc/risk";
// Pure auto-target API lives in the dep-free `./auto-targets` module (so the
// no-DB risk-check harness can pin it). Imported locally (so `readMaxMultCeiling`
// can reference the default) and re-exported below so existing import sites keep
// importing the whole auto-target surface from `risk-config`.
import {
  TARGET_PACK_EDGE,
  DEFAULT_MAX_MULT_CEILING,
  DEFAULT_TARGET_WIN_RATE,
  DEFAULT_NEAR_MISS_MIN,
  DEFAULT_EDGE_FLOOR,
  DEFAULT_EDGE_CEILING,
  DEFAULT_EDGE_CURVE,
  autoMaxWinCap,
  autoRetuneTargets,
  autoTargetEdge,
  parsePackHitRate,
  type ResolvedAutoTargetCfg,
  type AutoRetuneTargets,
  type EdgeCurveConfig,
} from "./auto-targets";

/**
 * Shared Pack-Studio risk-compliance configuration — the single source of truth
 * for the thresholds the snapshot writer flags on AND the overview/doctor reads
 * re-derive, so the two cannot drift.
 *
 * The PURE auto-target helpers (`autoMaxWinCap`, `autoRetuneTargets`) and their
 * tunables live in the dep-free `./auto-targets` module; they're re-exported here
 * so existing import sites keep importing from `risk-config`. The DB-coupled
 * config READS (`readMaxWinCap`, `readMaxMultCeiling`) stay in this module.
 */

// Re-export the pure auto-target API (single source of truth in ./auto-targets).
export {
  TARGET_PACK_EDGE,
  DEFAULT_MAX_MULT_CEILING,
  DEFAULT_TARGET_WIN_RATE,
  DEFAULT_NEAR_MISS_MIN,
  DEFAULT_EDGE_FLOOR,
  DEFAULT_EDGE_CEILING,
  DEFAULT_EDGE_CURVE,
  autoMaxWinCap,
  autoRetuneTargets,
  autoTargetEdge,
  parsePackHitRate,
  type ResolvedAutoTargetCfg,
  type AutoRetuneTargets,
  type EdgeCurveConfig,
};

/**
 * Pack types in scope for Pack-Studio risk scoring: the real-money "cash" packs
 * a player pays a sticker price to open. `reward` (free daily/welcome) and
 * `shard` (separate shard-cost model) are deliberately excluded.
 *
 * There is NO `custom` pack type — every cash pack is just an `official` pack.
 * (The Pack Studio Builder produces `official` packs; the distinct pack_types in
 * prod are official/reward/shard, and a read-only prod probe confirms zero
 * `custom` rows.) So the cash-pack scope is `official` only — the single set the
 * snapshot writer scores AND the re-price/re-tune tools mutate.
 */
export const PACK_STUDIO_CASH_PACK_TYPES = ["official"] as const;

/** Default max single-win cap (USD) when `pack_system_config` is unset. */
export const DEFAULT_MAX_WIN_CAP = 25000;

/**
 * Below this near-miss probability a pack is flagged `zeroNearMiss` — it offers
 * essentially no "close but no win" outcomes, which dulls the play feel.
 */
export const ZERO_NEAR_MISS_FLOOR = 0.005;

/**
 * Near-miss coverage threshold for the overview "nearMissCoverage" KPI: a pack
 * counts as having meaningful near-miss play if its near-miss mass ≥ this.
 */
export const NEAR_MISS_COVERAGE_MIN = 0.05;

/**
 * Server-side fail-closed safety floor for any direct pool write that bypasses
 * the auto-retune shaper (`applyPackEdit` writes operator weights verbatim;
 * `applyPackRetune` writes shaped weights). No matter what the operator
 * approved client-side, the server refuses to commit a pool whose computed
 * house edge lands below this fraction. 5% is intentionally generous vs. the
 * 10.99% edge-curve target (`TARGET_PACK_EDGE`) — the curve is the TARGET,
 * this is the absolute "never ship below this" guard rail. The client-side
 * double-confirm in the retune review is a UX defense and was demonstrably
 * bypassed once by a stale browser bundle; this server constant is the
 * backstop a stale client can never talk us out of. Lift only with deliberate
 * follow-up.
 */
export const EDIT_EDGE_FLOOR = 0.05;

/**
 * Per-pack compliance flags persisted in `pack_risk_scores.compliance` (JSON)
 * by the snapshot writer and read back by the overview/doctor surfaces.
 */
export type PackComplianceFlags = {
  /** Pack edge is below the {@link TARGET_PACK_EDGE} target. */
  belowTargetEdge: boolean;
  /** Top single-card win exceeds the configured max-win cap. */
  overMaxWinCap: boolean;
  /** Near-miss mass is below {@link ZERO_NEAR_MISS_FLOOR}. */
  zeroNearMiss: boolean;
  /** Volatility tier is the highest bucket (T5). */
  overTier: boolean;
};

/**
 * Build the per-pack compliance flag payload persisted in
 * `pack_risk_scores.compliance`. The single source of truth for the compliance
 * rule — both the snapshot writer (`snapshotPackRisk`) AND the post-retune
 * risk re-write (`applyPackRetune`) call this so the two cannot drift. The
 * house-edge target + zero-near-miss floor are module constants; the win-cap is
 * resolved by the caller via `readMaxWinCap`; everything else is derived from
 * the computed {@link PackRisk}.
 */
export function buildPackCompliance(
  risk: PackRisk,
  maxWinCap: number,
): PackComplianceFlags {
  return {
    belowTargetEdge: risk.edge < TARGET_PACK_EDGE,
    overMaxWinCap: risk.maxWin > maxWinCap,
    zeroNearMiss: risk.nearMiss < ZERO_NEAR_MISS_FLOOR,
    overTier: risk.tier === "T5",
  };
}

/** Runtime guard: is an unknown JSON blob the {@link PackComplianceFlags} shape? */
export function isPackComplianceFlags(v: unknown): v is PackComplianceFlags {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.belowTargetEdge === "boolean" &&
    typeof o.overMaxWinCap === "boolean" &&
    typeof o.zeroNearMiss === "boolean" &&
    typeof o.overTier === "boolean"
  );
}

/**
 * The pack-system config blob stored as a JSON string under the
 * `admin_settings.pack_system_config` key. Only the fields Pack-Studio risk
 * scoring reads are typed here; the blob may carry more (the ramp config the
 * overview also reads).
 */
export type PackSystemConfig = {
  /** Max single-card win cap (USD). */
  maxWinCap?: number;
  /**
   * Ceiling on a single card's payout as a MULTIPLE of the pack price (e.g.
   * 100 = "no card may pay more than 100× the ticket"). Combined with
   * `maxWinCap` by {@link autoMaxWinCap} (the per-pack cap is the lesser of the
   * two). Unset → {@link DEFAULT_MAX_MULT_CEILING}.
   */
  maxMultCeiling?: number;
  /** Ramp phase label (e.g. "phase1"). */
  phase?: string;
  /** Reserve capital (USD) backing the current ramp phase. */
  reserves?: number;
  /**
   * Optional overrides for the per-pack edge curve (floor / ceiling / premium
   * coefficients). Any field omitted falls back to {@link DEFAULT_EDGE_CURVE}.
   * Read + validated by {@link readEdgeCurveConfig}.
   */
  edgeCurve?: Partial<EdgeCurveConfig>;
};

/** ADMIN-DB settings key holding the pack-system config JSON blob. */
export const PACK_SYSTEM_CONFIG_KEY = "pack_system_config";

/**
 * Read + parse `admin_settings.pack_system_config`. Returns `null` if the key is
 * unset, the table is unmigrated (`getAdminSetting` returns null), or the value
 * isn't valid JSON — callers fall back to safe defaults rather than crash.
 */
export async function readPackSystemConfig(): Promise<PackSystemConfig | null> {
  const raw = await getAdminSetting(PACK_SYSTEM_CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as PackSystemConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve the max-win cap (USD): the `maxWinCap` field of the pack-system config
 * blob if present and a positive finite number, else {@link DEFAULT_MAX_WIN_CAP}.
 */
export async function readMaxWinCap(): Promise<number> {
  const cfg = await readPackSystemConfig();
  const cap = cfg?.maxWinCap;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) return cap;
  return DEFAULT_MAX_WIN_CAP;
}

/**
 * Resolve the max-multiple ceiling: the `maxMultCeiling` field of the pack-system
 * config blob if present and a positive finite number, else
 * {@link DEFAULT_MAX_MULT_CEILING}.
 */
export async function readMaxMultCeiling(): Promise<number> {
  const cfg = await readPackSystemConfig();
  const m = cfg?.maxMultCeiling;
  if (typeof m === "number" && Number.isFinite(m) && m > 0) return m;
  return DEFAULT_MAX_MULT_CEILING;
}

/** Keep only the positive-finite overrides from a partial edge-curve blob. */
function sanitizeEdgeCurveOverride(
  o: Partial<EdgeCurveConfig> | undefined,
): EdgeCurveConfig {
  const merged: EdgeCurveConfig = { ...DEFAULT_EDGE_CURVE };
  if (!o || typeof o !== "object") return merged;
  const keys: (keyof EdgeCurveConfig)[] = [
    "edgeFloor",
    "edgeCeiling",
    "maxWinCoef",
    "priceCoef",
    "maxWinBase",
    "maxWinRef",
    "priceBase",
    "priceRef",
  ];
  for (const k of keys) {
    const v = o[k];
    // Accept only positive finite numbers; coefficients may be 0 (no premium
    // from that driver), so those two allow ≥ 0.
    const allowZero = k === "maxWinCoef" || k === "priceCoef";
    if (typeof v === "number" && Number.isFinite(v) && (allowZero ? v >= 0 : v > 0)) {
      merged[k] = v;
    }
  }
  // Guard the invariant the curve relies on: floor ≤ ceiling, ref > base. If an
  // override breaks either, fall back to the default for the offending pair so
  // `autoTargetEdge` can never produce a degenerate (NaN / inverted) band.
  if (!(merged.edgeFloor <= merged.edgeCeiling)) {
    merged.edgeFloor = DEFAULT_EDGE_CURVE.edgeFloor;
    merged.edgeCeiling = DEFAULT_EDGE_CURVE.edgeCeiling;
  }
  if (!(merged.maxWinRef > merged.maxWinBase)) {
    merged.maxWinBase = DEFAULT_EDGE_CURVE.maxWinBase;
    merged.maxWinRef = DEFAULT_EDGE_CURVE.maxWinRef;
  }
  if (!(merged.priceRef > merged.priceBase)) {
    merged.priceBase = DEFAULT_EDGE_CURVE.priceBase;
    merged.priceRef = DEFAULT_EDGE_CURVE.priceRef;
  }
  return merged;
}

/**
 * Resolve the per-pack edge-curve config: the {@link DEFAULT_EDGE_CURVE}
 * coefficients with any positive-finite overrides from
 * `pack_system_config.edgeCurve` merged in. Used to fill
 * {@link ResolvedAutoTargetCfg.edgeCurve} so `autoRetuneTargets` /
 * `autoTargetEdge` tune off the same source-of-truth blob as the cap config.
 * Always returns a complete, invariant-safe config (never throws, never NaN).
 */
export async function readEdgeCurveConfig(): Promise<EdgeCurveConfig> {
  const cfg = await readPackSystemConfig();
  return sanitizeEdgeCurveOverride(cfg?.edgeCurve);
}
