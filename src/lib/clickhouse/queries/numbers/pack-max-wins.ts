import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { toNumber } from "@/lib/utils/decimal";
import type {
  PackMaxWinRangeRow,
  PackMaxWinRow,
  PackMaxWinStats,
} from "@/lib/queries/pack-max-wins";

import { CH_DB } from "../_shared";

/**
 * ClickHouse twin of the /numbers pack max-win breakdown (Phase 2B
 * comparison-mode). Returns the SAME `PackMaxWinStats` shape as the canonical
 * Postgres twin `getPackMaxWinStats` (`src/lib/queries/pack-max-wins.ts`).
 *
 * PARITY with the Postgres definition: per non-shard, priced pack with ≥1 card,
 * the top single-card price ÷ pack price = the max-win multiplier; packs are
 * bucketed into 5×-wide ranges, split at 20×, and the catalog peak is reported.
 * This is CATALOG data — there is NO user scope and NO blacklist (mirrors the PG
 * twin, which applies none).
 *
 * SQL parity with the PG raw query:
 *   FROM packs p JOIN pack_cards pc JOIN cards c
 *   WHERE pack_type <> 'shard' AND price > 0
 *   GROUP BY pack HAVING COUNT(pack_cards) > 0, top_card = MAX(card.price).
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors): dedup latest row
 * per id with FINAL on EVERY joined table (packs, pack_cards, cards), drop
 * soft-deleted rows with `_peerdb_is_deleted = 0`. Money stays Decimal
 * end-to-end (`toString(price)` / `toString(max(price))` in SQL → `toNumber()`
 * in TS — never Float) so the price and top-card values are exact to the cent
 * and the derived multiplier is byte-identical to the PG path.
 *
 * The pure bucket helper + the reduction are duplicated from the PG twin (rather
 * than imported) because that module is Prisma-coupled (`@/lib/db`) and the CH
 * read graph must never reach a Postgres client — the parity script proves the
 * two stay in lock-step.
 */

const PACK_MAX_WIN_20X_THRESHOLD = 20;

/** 5×-wide buckets: 1–5×, 5–10×, 10–15×, … (mirror of the PG twin). */
function maxWinRangeBucket(multiplier: number): {
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

export async function getPackMaxWinStatsFromClickHouse(): Promise<PackMaxWinStats> {
  const rows = await clickhouseRead.query<RawPackMaxWinRow>({
    queryName: "numbers.pack_max_wins",
    sql: `
      SELECT
        toString(p.id) AS pack_id,
        p.name AS name,
        p.active AS active,
        toString(p.price) AS price,
        toString(max(c.price)) AS top_card_price
      FROM ${CH_DB}.public_packs AS p FINAL
      INNER JOIN ${CH_DB}.public_pack_cards AS pc FINAL ON pc.pack_id = p.id
      INNER JOIN ${CH_DB}.public_cards AS c FINAL ON c.id = pc.card_id
      WHERE p._peerdb_is_deleted = 0
        AND pc._peerdb_is_deleted = 0
        AND c._peerdb_is_deleted = 0
        AND p.pack_type != 'shard'
        AND p.price > 0
      GROUP BY p.id, p.name, p.active, p.price
      HAVING count(pc.id) > 0`,
  });

  const packs: PackMaxWinRow[] = rows
    .map((row) => {
      const priceUsd = toNumber(row.price);
      const topCardUsd = toNumber(row.top_card_price);
      const maxWinMultiplier = priceUsd > 0 ? topCardUsd / priceUsd : 0;
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
  const above20Count = packs.filter(
    (p) => p.maxWinMultiplier > PACK_MAX_WIN_20X_THRESHOLD,
  ).length;
  const atOrBelow20Count = totalPacks - above20Count;
  const rangeCounts = new Map<
    string,
    { label: string; order: number; count: number }
  >();

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
    twentyXSplit: {
      above: {
        count: above20Count,
        share: totalPacks > 0 ? above20Count / totalPacks : 0,
      },
      atOrBelow: {
        count: atOrBelow20Count,
        share: totalPacks > 0 ? atOrBelow20Count / totalPacks : 0,
      },
    },
    ranges,
    packs,
  };
}
