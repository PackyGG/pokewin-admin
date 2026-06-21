import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import { safeQuery } from "@/lib/errors/safe-query";
import { toNumber } from "@/lib/utils/decimal";
import {
  isPackComplianceFlags,
  readPackSystemConfig,
  DEFAULT_MAX_WIN_CAP,
  NEAR_MISS_COVERAGE_MIN,
  type PackComplianceFlags,
} from "../_lib/risk-config";
import { getPackMetaByIds } from "../_lib/pack-meta";

/**
 * One compliance-alert entry: the offending pack + the flag that tripped it.
 * Carries the display fields the overview alert lists render directly.
 */
export type ComplianceAlert = {
  packId: string;
  name: string;
  slug: string;
  packType: string;
  edge: number;
  maxWin: number;
  nearMiss: number;
  tier: string;
};

/** Ramp config surfaced on the overview (from `pack_system_config`, with defaults). */
export type RampConfig = {
  phase: string | null;
  reserves: number | null;
  maxWinCap: number;
};

export type PackStudioOverview = {
  /** Whether any snapshot has ever run (no rows → render an empty/“run it” state). */
  hasSnapshot: boolean;
  /** Most-recent `computed_at` across all score rows (ISO), or null if none. */
  lastComputedAt: string | null;
  /** Active cash packs currently scored. */
  activeTotal: number;
  /** Average pack edge across all scored packs (0..1). */
  avgEdge: number;
  /** Count of packs flagged `belowTargetEdge`. */
  countBelowTarget: number;
  /** Count of packs flagged `overMaxWinCap`. */
  countOverCap: number;
  /** Share (0..1) of packs whose near-miss mass ≥ {@link NEAR_MISS_COVERAGE_MIN}. */
  nearMissCoverage: number;
  /** Risk-tier histogram (T1..T5 → count). */
  tierDistribution: Record<string, number>;
  /** Ramp config (phase / reserves / win cap). */
  ramp: RampConfig;
  /** Compliance alert lists (one entry per offending pack per rule). */
  alerts: {
    belowTargetEdge: ComplianceAlert[];
    overMaxWinCap: ComplianceAlert[];
    zeroNearMiss: ComplianceAlert[];
    overTier: ComplianceAlert[];
  };
};

const EMPTY_OVERVIEW: PackStudioOverview = {
  hasSnapshot: false,
  lastComputedAt: null,
  activeTotal: 0,
  avgEdge: 0,
  countBelowTarget: 0,
  countOverCap: 0,
  nearMissCoverage: 0,
  tierDistribution: { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 },
  ramp: { phase: null, reserves: null, maxWinCap: DEFAULT_MAX_WIN_CAP },
  alerts: {
    belowTargetEdge: [],
    overMaxWinCap: [],
    zeroNearMiss: [],
    overTier: [],
  },
};

/**
 * Compute the Pack-Studio overview KPIs from the persisted `pack_risk_scores`
 * rows (ADMIN DB) plus a single batched pack-meta read from MAIN.
 *
 * The pack-meta read (`getPackMetaByIds`, ONE `id = ANY(...)` query) doubles as
 * the freshness/active check + the name/slug source for the alert lists.
 */
async function computeOverview(): Promise<PackStudioOverview> {
  const [rows, cfg] = await Promise.all([
    adminDb.pack_risk_scores.findMany({
      select: {
        pack_id: true,
        edge: true,
        near_miss: true,
        max_win: true,
        tier: true,
        compliance: true,
        computed_at: true,
      },
    }),
    readPackSystemConfig(),
  ]);

  const ramp: RampConfig = {
    phase: typeof cfg?.phase === "string" ? cfg.phase : null,
    reserves:
      typeof cfg?.reserves === "number" && Number.isFinite(cfg.reserves)
        ? cfg.reserves
        : null,
    maxWinCap:
      typeof cfg?.maxWinCap === "number" &&
      Number.isFinite(cfg.maxWinCap) &&
      cfg.maxWinCap > 0
        ? cfg.maxWinCap
        : DEFAULT_MAX_WIN_CAP,
  };

  if (rows.length === 0) {
    return { ...EMPTY_OVERVIEW, ramp };
  }

  const meta = await getPackMetaByIds(rows.map((r) => r.pack_id));

  // Only count score rows whose pack still exists + is active on MAIN — a pack
  // deleted/deactivated after its score was written shouldn't skew the KPIs.
  const scored = rows
    .map((r) => {
      const m = meta.get(r.pack_id);
      if (!m || !m.active) return null;
      const flags: PackComplianceFlags | null = isPackComplianceFlags(r.compliance)
        ? r.compliance
        : null;
      return {
        packId: r.pack_id,
        name: m.name,
        slug: m.slug,
        packType: m.packType,
        edge: toNumber(r.edge),
        nearMiss: toNumber(r.near_miss),
        maxWin: toNumber(r.max_win),
        tier: r.tier,
        flags,
        computedAt: r.computed_at,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (scored.length === 0) {
    return { ...EMPTY_OVERVIEW, hasSnapshot: true, ramp };
  }

  const activeTotal = scored.length;
  const avgEdge =
    scored.reduce((s, r) => s + r.edge, 0) / activeTotal;

  const countBelowTarget = scored.filter((r) => r.flags?.belowTargetEdge).length;
  const countOverCap = scored.filter((r) => r.flags?.overMaxWinCap).length;

  const nearMissOk = scored.filter(
    (r) => r.nearMiss >= NEAR_MISS_COVERAGE_MIN,
  ).length;
  const nearMissCoverage = nearMissOk / activeTotal;

  const tierDistribution: Record<string, number> = {
    T1: 0,
    T2: 0,
    T3: 0,
    T4: 0,
    T5: 0,
  };
  for (const r of scored) {
    tierDistribution[r.tier] = (tierDistribution[r.tier] ?? 0) + 1;
  }

  const toAlert = (r: (typeof scored)[number]): ComplianceAlert => ({
    packId: r.packId,
    name: r.name,
    slug: r.slug,
    packType: r.packType,
    edge: r.edge,
    maxWin: r.maxWin,
    nearMiss: r.nearMiss,
    tier: r.tier,
  });

  const alerts = {
    belowTargetEdge: scored.filter((r) => r.flags?.belowTargetEdge).map(toAlert),
    overMaxWinCap: scored.filter((r) => r.flags?.overMaxWinCap).map(toAlert),
    zeroNearMiss: scored.filter((r) => r.flags?.zeroNearMiss).map(toAlert),
    overTier: scored.filter((r) => r.flags?.overTier).map(toAlert),
  };

  const lastComputedAt = scored
    .reduce(
      (max, r) => (r.computedAt > max ? r.computedAt : max),
      scored[0]!.computedAt,
    )
    .toISOString();

  return {
    hasSnapshot: true,
    lastComputedAt,
    activeTotal,
    avgEdge,
    countBelowTarget,
    countOverCap,
    nearMissCoverage,
    tierDistribution,
    ramp,
    alerts,
  };
}

/**
 * Cached Pack-Studio overview (60s). Wrapped in `safeQuery` so a read failure
 * degrades to the empty overview shape rather than crashing the page; the cache
 * key is static (the snapshot is a single global dataset, no per-period split).
 */
export async function getPackStudioOverview(): Promise<PackStudioOverview> {
  const cached = unstable_cache(
    () => computeOverview(),
    ["pack-studio-overview-v1"],
    { revalidate: 60, tags: ["pack-studio-overview"] },
  );
  const { data } = await safeQuery(
    () => cached(),
    EMPTY_OVERVIEW,
    "pack-studio.overview",
  );
  return data;
}
