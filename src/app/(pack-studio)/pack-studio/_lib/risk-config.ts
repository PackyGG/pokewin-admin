import { getAdminSetting } from "@/lib/admin-settings";
import { TARGET_HOUSE_EDGE } from "@/app/(admin)/insights/edge-calc/math";

/**
 * Shared Pack-Studio risk-compliance configuration — the single source of truth
 * for the thresholds the snapshot writer flags on AND the overview/doctor reads
 * re-derive, so the two cannot drift.
 */

/**
 * Pack types in scope for Pack-Studio risk scoring: the real-money "cash" packs
 * a player pays a sticker price to open. `reward` (free daily/welcome) and
 * `shard` (separate shard-cost model) are deliberately excluded — matching the
 * re-price tool's `official`-only scope. (There is no `custom` pack type; every
 * cash pack is just a pack.)
 */
export const PACK_STUDIO_CASH_PACK_TYPES = ["official"] as const;

/** Target house edge a compliant cash pack must hit (10.99%). */
export const TARGET_PACK_EDGE = TARGET_HOUSE_EDGE;

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
  /** Ramp phase label (e.g. "phase1"). */
  phase?: string;
  /** Reserve capital (USD) backing the current ramp phase. */
  reserves?: number;
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
