import { getPackStats } from "@/lib/queries/packs";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { PackStatsSection } from "./revenue-chart";

/**
 * PackStatsLazy — server boundary for the below-the-fold stats charts on
 * /packs/[id] (period tiles + Revenue/Payout bar + Daily-Openings stacked bar
 * + the two breakdown pies).
 *
 * Why this is its own async server component (and not part of the page's
 * upfront awaits): `getPackStats` runs TWO unindexed JSON full-scans over
 * `provably_fair_results` filtered on `result_metadata->>'pack_id'`. The old
 * page awaited both BEFORE first paint, even though every chart lives below the
 * fold and the above-the-fold KPI strip is derived from the maintained
 * `packs.*` columns (no scan needed). That's the "load hidden/below-the-fold
 * heavy work before it's shown" anti-pattern the Active-View-Only rule forbids.
 *
 * Now the page renders this section inside a <Suspense> AFTER the KPI strip +
 * card pool, so the two scans run while the operator is already looking at the
 * page — not blocking the first paint. The fetch is wrapped in `safeQuery` with
 * a wall-clock timeout so a pathological lifetime scan degrades to a fallback
 * tile instead of hanging the segment (matching the Games tab's pattern).
 */

// The daily breakdown + the "All" lifetime bucket are unbounded scans on a
// high-volume pack. Bound the wait so a slow scan degrades rather than hanging
// the charts; the result is already cached 60s by cachedPackStatScans.
const STATS_QUERY_TIMEOUT_MS = 15_000;

const EMPTY_STATS = {
  openings: { d1: 0, d3: 0, d7: 0, d30: 0, all: 0 },
  revenue: { d1: 0, d3: 0, d7: 0, d30: 0, all: 0 },
  payout: { d1: 0, d3: 0, d7: 0, d30: 0, all: 0 },
  rtp: 0,
  houseEdge: 0,
  daily: [],
  soloBreakdown: [],
  battleBreakdown: [],
} satisfies Awaited<ReturnType<typeof getPackStats>>;

export async function PackStatsLazy({
  packId,
  packPrice,
  totalPayout,
  actualRtp,
}: {
  packId: string;
  packPrice: number;
  totalPayout: number;
  actualRtp: number;
}) {
  const { data, error } = await safeQuery(
    () =>
      getPackStats(packId, packPrice, { totalPayout, actualRtp }),
    EMPTY_STATS,
    "packs.detail.stats",
    STATS_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <TileErrorFallback
        label="Pack stats"
        hint="The pack stats scan timed out or failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return <PackStatsSection stats={data} />;
}
