import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import { safeQuery } from "@/lib/errors/safe-query";
import { toNumber } from "@/lib/utils/decimal";
import {
  isPackComplianceFlags,
  type PackComplianceFlags,
} from "../_lib/risk-config";
import { getPackMetaByIds } from "../_lib/pack-meta";

/**
 * One row of the Pack Doctor grid: the persisted risk score joined to the pack
 * identity (name/slug/price/type) batch-read from MAIN.
 */
export type PackRiskRow = {
  packId: string;
  name: string;
  slug: string;
  packType: string;
  /** Current sticker price (USD) from MAIN. */
  price: number;
  edge: number;
  cv: number;
  winRate: number;
  nearMiss: number;
  maxWin: number;
  maxMult: number;
  riskScore: number;
  tier: string;
  compliance: PackComplianceFlags | null;
  computedAt: string;
};

export type PackRiskSortKey =
  | "name"
  | "price"
  | "edge"
  | "cv"
  | "winRate"
  | "nearMiss"
  | "maxWin"
  | "maxMult"
  | "riskScore"
  | "tier";

export type PackRiskFilters = {
  /** Restrict to a single tier (T1..T5). */
  tier?: string;
  /** Only packs flagged below the edge target. */
  belowTarget?: boolean;
  /** Only packs over the max-win cap. */
  overCap?: boolean;
  /** Only packs with (near-)zero near-miss mass. */
  zeroNearMiss?: boolean;
  /** Sort column (default "riskScore"). */
  sortBy?: PackRiskSortKey;
  /** Sort direction (default "desc"). */
  sortDir?: "asc" | "desc";
};

function compareRows(
  a: PackRiskRow,
  b: PackRiskRow,
  key: PackRiskSortKey,
): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "tier":
      return a.tier.localeCompare(b.tier);
    case "price":
      return a.price - b.price;
    case "edge":
      return a.edge - b.edge;
    case "cv":
      return a.cv - b.cv;
    case "winRate":
      return a.winRate - b.winRate;
    case "nearMiss":
      return a.nearMiss - b.nearMiss;
    case "maxWin":
      return a.maxWin - b.maxWin;
    case "maxMult":
      return a.maxMult - b.maxMult;
    case "riskScore":
      return a.riskScore - b.riskScore;
  }
}

/** Plain, JSON-safe score row (numbers/strings only) — what the cache stores. */
type CachedScore = Omit<PackRiskRow, "name" | "slug" | "packType" | "price">;

/**
 * Cached raw scores (ADMIN DB ONLY — no cookies, so safe inside `unstable_cache`).
 * Mapped to plain primitives INSIDE the cache so the JSON round-trip on a cache
 * hit can't hand back a Decimal/Date that later breaks `.toISOString()`. The MAIN
 * pack-meta join is deliberately NOT here: `getPackMetaByIds` → `getDb()` reads
 * the `admin_db_env` cookie, and calling `cookies()` inside `unstable_cache`
 * throws ("Server Components render" error). The join happens in the caller below.
 */
const getCachedScores = unstable_cache(
  async (): Promise<CachedScore[]> => {
    const scores = await adminDb.pack_risk_scores.findMany();
    return scores.map((s) => ({
      packId: s.pack_id,
      edge: toNumber(s.edge),
      cv: toNumber(s.cv),
      winRate: toNumber(s.win_rate),
      nearMiss: toNumber(s.near_miss),
      maxWin: toNumber(s.max_win),
      maxMult: toNumber(s.max_mult),
      riskScore: s.risk_score,
      tier: s.tier,
      compliance: isPackComplianceFlags(s.compliance) ? s.compliance : null,
      computedAt: s.computed_at.toISOString(),
    }));
  },
  ["pack-studio-doctor-scores-v2"],
  { revalidate: 60, tags: ["pack-studio-overview"] },
);

/**
 * Build the Pack Doctor grid rows: read the cached `pack_risk_scores` (ADMIN),
 * then batch-join pack identity from MAIN (`getPackMetaByIds`, ONE `id = ANY(...)`
 * read) OUTSIDE the cache, then filter + sort in memory. A score row whose pack
 * no longer exists on MAIN is dropped (stale score). Any read failure degrades to
 * an empty grid rather than crashing the page.
 */
export async function getPackRiskRows(
  filters?: PackRiskFilters,
): Promise<PackRiskRow[]> {
  try {
    const { data: scores } = await safeQuery(
      () => getCachedScores(),
      [] as CachedScore[],
      "pack-studio.doctor",
    );
    if (scores.length === 0) return [];

    // MAIN pack-meta join OUTSIDE the cache (getDb reads the db-env cookie).
    const meta = await getPackMetaByIds(scores.map((s) => s.packId));

    let rows: PackRiskRow[] = scores
      .map((s) => {
        const m = meta.get(s.packId);
        if (!m) return null;
        return {
          ...s,
          name: m.name,
          slug: m.slug,
          packType: m.packType,
          price: m.price,
        };
      })
      .filter((x): x is PackRiskRow => x !== null);

    if (filters?.tier) {
      rows = rows.filter((r) => r.tier === filters.tier);
    }
    if (filters?.belowTarget) {
      rows = rows.filter((r) => r.compliance?.belowTargetEdge === true);
    }
    if (filters?.overCap) {
      rows = rows.filter((r) => r.compliance?.overMaxWinCap === true);
    }
    if (filters?.zeroNearMiss) {
      rows = rows.filter((r) => r.compliance?.zeroNearMiss === true);
    }

    const sortBy = filters?.sortBy ?? "riskScore";
    const dir = filters?.sortDir ?? "desc";
    rows.sort((a, b) => {
      const cmp = compareRows(a, b, sortBy);
      return dir === "asc" ? cmp : -cmp;
    });

    return rows;
  } catch {
    return [];
  }
}
