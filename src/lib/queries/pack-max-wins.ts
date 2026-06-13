import "server-only";

import { unstable_cache } from "next/cache";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { dbForEnv } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type PackMaxWinRow = {
  packId: string;
  name: string;
  active: boolean;
  priceUsd: number;
  topCardUsd: number;
  /** Best single-card pull ÷ pack price (e.g. $400 on a $1 pack → 400). */
  maxWinMultiplier: number;
  rangeKey: string;
  rangeLabel: string;
  rangeOrder: number;
};

export type PackMaxWinRangeRow = {
  key: string;
  label: string;
  order: number;
  packCount: number;
  share: number;
};

export type PackMaxWinStats = {
  totalPacks: number;
  /** Highest max-win pack in the catalog. */
  peak: { name: string; maxWinMultiplier: number } | null;
  ranges: PackMaxWinRangeRow[];
  packs: PackMaxWinRow[];
};

/** 5×-wide buckets: 1–5×, 5–10×, 10–15×, … */
export function maxWinRangeBucket(multiplier: number): {
  key: string;
  label: string;
  order: number;
} {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return { key: "na", label: "N/A", order: -1 };
  }
  if (multiplier < 1) {
    return { key: "lt1", label: "<1×", order: 0 };
  }
  if (multiplier < 5) {
    return { key: "1-5", label: "1–5×", order: 1 };
  }
  const idx = Math.floor(multiplier / 5);
  const low = idx * 5;
  const high = (idx + 1) * 5;
  return {
    key: `${low}-${high}`,
    label: `${low}–${high}×`,
    order: idx + 1,
  };
}

type RawPackMaxWinRow = {
  pack_id: string;
  name: string;
  active: boolean;
  price: string;
  top_card_price: string;
};

async function computePackMaxWinStats(env: DbEnv): Promise<PackMaxWinStats> {
  const db = dbForEnv(env);
  const rows = await db.$queryRaw<RawPackMaxWinRow[]>`
    SELECT
      p.id::text AS pack_id,
      p.name,
      p.active,
      p.price::text AS price,
      COALESCE(MAX(c.price::numeric), 0)::text AS top_card_price
    FROM packs p
    JOIN pack_cards pc ON pc.pack_id = p.id
    JOIN cards c ON c.id = pc.card_id
    WHERE p.pack_type::text <> 'shard'
      AND p.price::numeric > 0
    GROUP BY p.id, p.name, p.active, p.price
    HAVING COUNT(pc.id) > 0
  `;

  const packs: PackMaxWinRow[] = rows
    .map((row) => {
      const priceUsd = toNumber(row.price);
      const topCardUsd = toNumber(row.top_card_price);
      const maxWinMultiplier =
        priceUsd > 0 ? topCardUsd / priceUsd : 0;
      const bucket = maxWinRangeBucket(maxWinMultiplier);
      return {
        packId: row.pack_id,
        name: row.name,
        active: row.active,
        priceUsd,
        topCardUsd,
        maxWinMultiplier,
        rangeKey: bucket.key,
        rangeLabel: bucket.label,
        rangeOrder: bucket.order,
      };
    })
    .sort((a, b) => b.maxWinMultiplier - a.maxWinMultiplier);

  const totalPacks = packs.length;
  const rangeCounts = new Map<string, { label: string; order: number; count: number }>();

  for (const pack of packs) {
    const existing = rangeCounts.get(pack.rangeKey);
    if (existing) {
      existing.count += 1;
    } else {
      rangeCounts.set(pack.rangeKey, {
        label: pack.rangeLabel,
        order: pack.rangeOrder,
        count: 1,
      });
    }
  }

  const ranges: PackMaxWinRangeRow[] = [...rangeCounts.entries()]
    .map(([key, value]) => ({
      key,
      label: value.label,
      order: value.order,
      packCount: value.count,
      share: totalPacks > 0 ? value.count / totalPacks : 0,
    }))
    .sort((a, b) => a.order - b.order);

  return {
    totalPacks,
    peak: packs[0]
      ? { name: packs[0].name, maxWinMultiplier: packs[0].maxWinMultiplier }
      : null,
    ranges,
    packs,
  };
}

const cachedPackMaxWinStats = unstable_cache(
  computePackMaxWinStats,
  ["pack-max-win-stats-v1"],
  { revalidate: 300, tags: ["packs"] },
);

export async function getPackMaxWinStats(): Promise<PackMaxWinStats> {
  const env = await readDbEnv();
  if (env !== "prod") {
    return computePackMaxWinStats(env);
  }
  return cachedPackMaxWinStats(env);
}

export function formatMaxWinMultiplier(multiplier: number): string {
  if (!Number.isFinite(multiplier)) return "—";
  if (multiplier >= 100) return `${Math.round(multiplier)}×`;
  if (multiplier >= 10) return `${multiplier.toFixed(1)}×`;
  return `${multiplier.toFixed(2)}×`;
}
