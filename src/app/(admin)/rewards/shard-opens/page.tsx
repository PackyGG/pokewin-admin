import { Suspense } from "react";
import {
  Gem,
  Layers,
  Users,
  ArrowDownLeft,
  ArrowUpRight,
  Scale,
  Percent,
  PackageOpen,
  AlertTriangle,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatNumber } from "@/lib/utils/format";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  getShardPackOpens,
  parseShardOpensPeriod,
  shardOpensPeriodLabel,
  type ShardOpensPeriod,
} from "@/lib/queries/shard-pack-opens";
import { OpensPeriodFilter } from "./opens-period-filter";
import { ShardOpensDataTable } from "./opens-data-table";

export const metadata = { title: "Shard Pack Opens" };

/** Round + format a shard amount; guards NaN/Infinity to "—". */
function fmtShards(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? formatNumber(rounded)
    : rounded.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

function fmtEdge(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(1)}%`;
}

/**
 * Shard-pack opens — every open of a pack bought with SHARDS (the secondary,
 * wager-earned currency), with shards spent + shards won, the net house shard
 * flow, a per-pack breakdown, and a paginated feed of individual opens.
 *
 * Active-timeframe-only: the active window + active page are parsed from the
 * URL and fetched in ONE keyed Suspense boundary — no eager preload of the
 * other windows/pages. Heavy read is cached per (period, page, perPage) and
 * wrapped in safeQuery so a slow/failed read degrades to a fallback tile
 * instead of hanging the segment.
 *
 * UNIT/POV: all figures are SHARDS, never USD. House-POV coloring: shards
 * users SPEND into opens (house in) = emerald; shards users WIN (house
 * liability) = rose; net house up = emerald, down = rose.
 *
 * SCOPE: UNSCOPED raw activity feed (staff/creator opens shown too) — this is
 * "who opened shard packs and what happened", not the USD GGR/NGR metric
 * layer.
 */
async function OpensContent({
  period,
  page,
  perPage,
}: {
  period: ShardOpensPeriod;
  page: number;
  perPage: number;
}) {
  const EMPTY: Awaited<ReturnType<typeof getShardPackOpens>> = {
    available: true,
    period,
    summary: {
      totalOpens: 0,
      uniqueOpeners: 0,
      totalSpent: 0,
      totalWon: 0,
      netHouse: 0,
      avgSpentPerOpen: 0,
      houseEdgePct: null,
    },
    packs: [],
    feed: { data: [], total: 0, page, perPage, totalPages: 0 },
  };

  const { data: result, error } = await safeQuery(
    () => getShardPackOpens(period, page, perPage),
    EMPTY,
    "rewards.shard-opens",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const failed = error !== null;
  const periodLabel = shardOpensPeriodLabel(period);

  if (failed) {
    return (
      <TileErrorFallback
        label="Shard-pack opens"
        hint="The read failed or timed out — no data was changed. Refresh to retry."
        size="panel"
      />
    );
  }

  if (!result.available) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/30 p-6 text-center">
        <Gem className="mx-auto size-7 text-muted-foreground/60" />
        <p className="mt-2 text-sm font-medium">
          No coin/shard ledger on this database
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          The connected database has no{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
            coin_transactions
          </code>{" "}
          table, so shard-pack opens aren&apos;t available here. Switch to a
          database with the sweepstakes schema (dev) to see shard-pack activity.
        </p>
      </div>
    );
  }

  const { summary, packs, feed } = result;

  return (
    <>
      {/* KPI strip — all SHARDS, House-POV colored. spent = house in
          (emerald), won = house out (rose), net house = emerald/rose by
          sign. opens/openers/avg/edge are neutral readouts (cyan/amber/
          purple). */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        <KpiTile
          label="Opens"
          value={formatNumber(summary.totalOpens)}
          sub={periodLabel}
          icon={PackageOpen}
          accent="cyan"
        />
        <KpiTile
          label="Unique openers"
          value={formatNumber(summary.uniqueOpeners)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Shards wagered"
          value={fmtShards(summary.totalSpent)}
          sub="house in"
          icon={ArrowDownLeft}
          accent="emerald"
        />
        <KpiTile
          label="Shards won"
          value={fmtShards(summary.totalWon)}
          sub="house out"
          icon={ArrowUpRight}
          accent="rose"
        />
        <KpiTile
          label="Net house"
          value={fmtShards(summary.netHouse)}
          sub={summary.netHouse >= 0 ? "shards · house up" : "shards · house down"}
          icon={Scale}
          accent={summary.netHouse >= 0 ? "emerald" : "rose"}
        />
        <KpiTile
          label="Avg per open"
          value={fmtShards(summary.avgSpentPerOpen)}
          sub="shards spent"
          icon={Gem}
          accent="amber"
        />
        <KpiTile
          label="House edge"
          value={fmtEdge(summary.houseEdgePct)}
          sub="of shards wagered"
          icon={Percent}
          accent="purple"
        />
      </div>

      {/* Per-pack breakdown */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Layers} title="By shard pack" />
          <StatPanel title="Opens · wagered · won · edge per pack" icon={Layers} accent="cyan">
            {packs.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No shard-pack opens in {periodLabel.toLowerCase()}.
              </p>
            ) : (
              <div className="space-y-0.5">
                {packs.map((p) => (
                  <PanelRow
                    key={p.packId}
                    label={`${p.packName} · ${formatNumber(p.opens)} open${p.opens === 1 ? "" : "s"} · edge ${fmtEdge(p.houseEdgePct)}`}
                    value={
                      <span className="flex items-center gap-3 tabular-nums">
                        <span
                          className="text-emerald-600 dark:text-emerald-400"
                          title="Shards wagered into this pack (house in)"
                        >
                          +{fmtShards(p.spent)}
                        </span>
                        <span
                          className="text-rose-600 dark:text-rose-400"
                          title="Shards won from this pack (house out)"
                        >
                          -{fmtShards(p.won)}
                        </span>
                        <span
                          className={
                            "font-medium " +
                            (p.netHouse >= 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400")
                          }
                          title="Net house (wagered − won) for this pack"
                        >
                          {p.netHouse >= 0 ? "+" : "-"}
                          {fmtShards(Math.abs(p.netHouse))}
                        </span>
                      </span>
                    }
                  />
                ))}
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                  Figures are in shards (a secondary, wager-earned currency),
                  not USD. Each row shows shards wagered (house in) · shards won
                  (house out) · net house. The cards an open rolls into
                  inventory are a separate USD concern accounted for in the
                  inventory ledger.
                </p>
              </div>
            )}
          </StatPanel>
        </div>
      </FadeIn>

      {/* Individual opens feed */}
      <div className="space-y-3">
        <SectionHeading icon={Gem} title="Individual opens" />
        <FadeIn>
          <ShardOpensDataTable data={feed.data} />
        </FadeIn>
        <DataTablePagination
          page={feed.page}
          totalPages={feed.totalPages}
          total={feed.total}
          perPage={feed.perPage}
        />
      </div>
    </>
  );
}

export default async function ShardPackOpensPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string; perPage?: string }>;
}) {
  await requirePageAccess("/rewards/shard-opens");

  // Active-timeframe-only: the single active window + active page come from
  // the URL so the server fetches ONLY that window/page (no eager preload).
  const params = await searchParams;
  const period = parseShardOpensPeriod(params.period);
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // Suspense key flips when window/page/size changes so the skeleton
  // re-shows on in-segment navigation instead of leaving stale rows during
  // a slow refetch.
  const suspenseKey = `${period}|${page}|${perPage}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gem}
          accent="cyan"
          title="Shard Pack Opens"
          subtitle="Every open of a pack bought with shards (a wager-earned currency) — how many shards each open cost and won. Figures are in shards, not USD."
          action={<OpensPeriodFilter />}
        />
      </PageHero>

      {/* Lazy band note: shard packs are opened rarely, so we don't expect
          a heavy read — but the same Active-Timeframe-Only + safeQuery
          contract applies so a future high-volume window degrades cleanly. */}
      <div className="flex items-start gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/5 px-4 py-2.5">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-cyan-500" />
        <p className="text-xs text-muted-foreground">
          Shards are a <span className="font-medium">secondary, wager-earned currency</span>{" "}
          — all amounts here are in shards, never USD. House-POV:{" "}
          <span className="text-emerald-600 dark:text-emerald-400">shards wagered</span> are taken
          in by the house, <span className="text-rose-600 dark:text-rose-400">shards won</span> are
          a house liability.
        </p>
      </div>

      <Suspense
        key={suspenseKey}
        fallback={
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
                />
              ))}
            </div>
            <div className="h-48 animate-pulse rounded-2xl border bg-muted/30" />
            <TableSkeleton rows={Math.min(perPage, 10)} columns={6} />
            <PaginationSkeleton />
          </div>
        }
      >
        <OpensContent period={period} page={page} perPage={perPage} />
      </Suspense>
    </div>
  );
}
