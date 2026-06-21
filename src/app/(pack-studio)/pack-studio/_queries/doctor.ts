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
  /** Restrict to a pack_type ("official" | "custom"). */
  type?: string;
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

/**
 * Build the Pack Doctor grid rows: read all persisted `pack_risk_scores`
 * (ADMIN), batch-join pack identity from MAIN keyed by the score pack ids
 * (`getPackMetaByIds`, ONE `id = ANY(...)` read), then filter + sort in memory.
 *
 * A score row whose pack no longer exists on MAIN is dropped (stale score).
 * Filtering/sorting is done in JS rather than SQL because the joined fields
 * (name/price/type) live in MAIN, the dataset is small (one row per active cash
 * pack), and the compliance predicates read a JSON blob — a single grouped read
 * + in-memory shaping is the simplest correct path here.
 */
async function fetchRows(filters?: PackRiskFilters): Promise<PackRiskRow[]> {
  const scores = await adminDb.pack_risk_scores.findMany();
  if (scores.length === 0) return [];

  const meta = await getPackMetaByIds(scores.map((s) => s.pack_id));

  let rows: PackRiskRow[] = scores
    .map((s) => {
      const m = meta.get(s.pack_id);
      if (!m) return null;
      const compliance: PackComplianceFlags | null = isPackComplianceFlags(
        s.compliance,
      )
        ? s.compliance
        : null;
      return {
        packId: s.pack_id,
        name: m.name,
        slug: m.slug,
        packType: m.packType,
        price: m.price,
        edge: toNumber(s.edge),
        cv: toNumber(s.cv),
        winRate: toNumber(s.win_rate),
        nearMiss: toNumber(s.near_miss),
        maxWin: toNumber(s.max_win),
        maxMult: toNumber(s.max_mult),
        riskScore: s.risk_score,
        tier: s.tier,
        compliance,
        computedAt: s.computed_at.toISOString(),
      };
    })
    .filter((x): x is PackRiskRow => x !== null);

  if (filters?.tier) {
    rows = rows.filter((r) => r.tier === filters.tier);
  }
  if (filters?.type) {
    rows = rows.filter((r) => r.packType === filters.type);
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
}

/**
 * Cached Pack Doctor rows (60s), keyed on the normalized filter set so distinct
 * filter combinations cache independently. Wrapped in `safeQuery` so a read
 * failure degrades to an empty grid instead of crashing the page.
 */
export async function getPackRiskRows(
  filters?: PackRiskFilters,
): Promise<PackRiskRow[]> {
  const keyParts = [
    filters?.tier ?? "",
    filters?.type ?? "",
    filters?.belowTarget ? "1" : "0",
    filters?.overCap ? "1" : "0",
    filters?.zeroNearMiss ? "1" : "0",
    filters?.sortBy ?? "riskScore",
    filters?.sortDir ?? "desc",
  ];
  const cached = unstable_cache(
    () => fetchRows(filters),
    ["pack-studio-doctor-rows-v1", ...keyParts],
    { revalidate: 60, tags: ["pack-studio-overview"] },
  );
  const { data } = await safeQuery(() => cached(), [], "pack-studio.doctor");
  return data;
}
