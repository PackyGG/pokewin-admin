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
  type PackSystemConfig,
} from "@/app/(admin)/packs/_lib/risk-config";
import { getPackMetaByIds } from "@/app/(admin)/packs/_lib/pack-meta";

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
  /** Average coefficient of variation (payout volatility) across scored packs. */
  avgCv: number;
  /** Composite 0–100 risk-score spread across scored packs (avg + min/max). */
  riskScore: { avg: number; min: number; max: number };
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
  avgCv: 0,
  riskScore: { avg: 0, min: 0, max: 0 },
  ramp: { phase: null, reserves: null, maxWinCap: DEFAULT_MAX_WIN_CAP },
  alerts: {
    belowTargetEdge: [],
    overMaxWinCap: [],
    zeroNearMiss: [],
    overTier: [],
  },
};

/** Plain, JSON-safe score row (numbers/strings only) — what the cache stores. */
type CachedScoreLite = {
  packId: string;
  edge: number;
  nearMiss: number;
  maxWin: number;
  /** Coefficient of variation of the pack's payout distribution. */
  cv: number;
  /** Composite 0–100 risk score. */
  riskScore: number;
  tier: string;
  flags: PackComplianceFlags | null;
  /** ISO string (already serialized so a cache hit can't hand back a Date). */
  computedAt: string;
};

/**
 * Cached cookie-free base: the ADMIN `pack_risk_scores` rows (mapped to plain
 * primitives INSIDE the cache so the JSON round-trip is safe) + the
 * `pack_system_config` blob (also ADMIN-only). The MAIN pack-meta join is NOT
 * here — `getPackMetaByIds` → `getDb()` reads the `admin_db_env` cookie, and
 * `cookies()` inside `unstable_cache` throws ("Server Components render" error).
 */
const getCachedOverviewBase = unstable_cache(
  async (): Promise<{ scores: CachedScoreLite[]; cfg: PackSystemConfig | null }> => {
    const [rows, cfg] = await Promise.all([
      adminDb.pack_risk_scores.findMany({
        select: {
          pack_id: true,
          edge: true,
          near_miss: true,
          max_win: true,
          cv: true,
          risk_score: true,
          tier: true,
          compliance: true,
          computed_at: true,
        },
      }),
      readPackSystemConfig(),
    ]);
    const scores: CachedScoreLite[] = rows.map((r) => ({
      packId: r.pack_id,
      edge: toNumber(r.edge),
      nearMiss: toNumber(r.near_miss),
      maxWin: toNumber(r.max_win),
      cv: toNumber(r.cv),
      riskScore: r.risk_score,
      tier: r.tier,
      flags: isPackComplianceFlags(r.compliance) ? r.compliance : null,
      computedAt: r.computed_at.toISOString(),
    }));
    return { scores, cfg };
  },
  ["pack-studio-overview-base-v3"],
  { revalidate: 60, tags: ["pack-studio-overview"] },
);

/**
 * Compute the Pack-Studio overview KPIs from the cached `pack_risk_scores` base
 * plus a single batched pack-meta read from MAIN (done OUTSIDE the cache, since
 * `getDb()` reads a cookie). The pack-meta read doubles as the freshness/active
 * check + the name/slug source for the alert lists.
 */
async function computeOverview(): Promise<PackStudioOverview> {
  const { scores: rawScores, cfg } = await getCachedOverviewBase();

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

  if (rawScores.length === 0) {
    return { ...EMPTY_OVERVIEW, ramp };
  }

  const meta = await getPackMetaByIds(rawScores.map((r) => r.packId));

  // Only count score rows whose pack still exists + is active on MAIN — a pack
  // deleted/deactivated after its score was written shouldn't skew the KPIs.
  const scored = rawScores
    .map((r) => {
      const m = meta.get(r.packId);
      if (!m || !m.active) return null;
      return {
        packId: r.packId,
        name: m.name,
        slug: m.slug,
        packType: m.packType,
        edge: r.edge,
        nearMiss: r.nearMiss,
        maxWin: r.maxWin,
        cv: r.cv,
        riskScore: r.riskScore,
        tier: r.tier,
        flags: r.flags,
        computedAt: r.computedAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (scored.length === 0) {
    return { ...EMPTY_OVERVIEW, hasSnapshot: true, ramp };
  }

  const activeTotal = scored.length;
  const avgEdge = scored.reduce((s, r) => s + r.edge, 0) / activeTotal;

  // Volatility (CV) + composite risk-score (0–100) spread across the scored
  // catalog — the headline numbers the Overview "Risk System" box surfaces.
  const avgCv = scored.reduce((s, r) => s + r.cv, 0) / activeTotal;
  const riskScores = scored.map((r) => r.riskScore);
  const riskScore = {
    avg: riskScores.reduce((s, v) => s + v, 0) / activeTotal,
    min: Math.min(...riskScores),
    max: Math.max(...riskScores),
  };

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

  // `computedAt` is already an ISO-8601 string; lexicographic max == chronological max.
  const lastComputedAt = scored.reduce(
    (max, r) => (r.computedAt > max ? r.computedAt : max),
    scored[0]!.computedAt,
  );

  return {
    hasSnapshot: true,
    lastComputedAt,
    activeTotal,
    avgEdge,
    countBelowTarget,
    countOverCap,
    nearMissCoverage,
    tierDistribution,
    avgCv,
    riskScore,
    ramp,
    alerts,
  };
}

/**
 * Pack-Studio overview. Wrapped in `safeQuery` so a read failure degrades to the
 * empty overview shape rather than crashing the page. Only the cookie-free base
 * read is cached ({@link getCachedOverviewBase}); the MAIN pack-meta join runs
 * fresh each call (cheap indexed PK read) because it reads the db-env cookie.
 */
export async function getPackStudioOverview(): Promise<PackStudioOverview> {
  const { data } = await safeQuery(
    () => computeOverview(),
    EMPTY_OVERVIEW,
    "pack-studio.overview",
  );
  return data;
}
