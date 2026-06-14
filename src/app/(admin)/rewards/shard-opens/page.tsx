import { Suspense } from "react";
import {
  Gem,
  Users,
  ArrowDownLeft,
  Scale,
  PackageOpen,
  Wallet,
  Globe,
  Coins,
  Activity,
  Gift,
  CreditCard,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatNumber, formatCurrency } from "@/lib/utils/format";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
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
  getShardEconomyOverview,
  shardOpensPeriodLabel,
  type ShardOpensPeriod,
  type ShardEconomyResult,
} from "@/lib/queries/shard-pack-opens";
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

/**
 * Shard ECONOMY OVERVIEW (Part A) — the live shard-supply snapshot + the
 * window-scoped flow aggregates, restored after /insights/coins was removed.
 * Numbers are REUSED verbatim from the canonical `getCoinsEconomy` (via
 * `getShardEconomyOverview`) — one source of truth, no second rollup.
 *
 * UNIT: SHARDS, never USD. Supply/holders/active are NEUTRAL readouts (cyan/
 * blue). House-POV on the cash-adjacent legs: shards users SPEND into games
 * (house in) = emerald; shards EARNED back as wins + ISSUED grants (house
 * liability) = rose; net house game flow = emerald when up, rose when down.
 */
async function EconomyOverviewContent({
  period,
}: {
  period: ShardOpensPeriod;
}) {
  const { data: economy } = await safeQuery<ShardEconomyResult>(
    () => getShardEconomyOverview(period),
    null,
    "rewards.shard-opens.economy",
    REWARD_QUERY_TIMEOUT_MS,
  );

  // Coin/shard ledger absent on this DB (or the read failed/timed out): hide
  // the overview rather than show a broken panel — the opens section below
  // renders its own degrade message. The supply snapshot is window-independent
  // so a degrade here is purely the ledger-absent / timeout case.
  if (!economy) return null;

  const periodLabel = shardOpensPeriodLabel(period);

  return (
    <FadeIn>
      <div className="space-y-3">
        <SectionHeading
          icon={Coins}
          title={
            <span className="flex items-center gap-2">
              Shard economy
              <span className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-600 dark:text-cyan-400">
                shards · not USD
              </span>
            </span>
          }
        />

        {/* Supply snapshot (window-independent) — "how many shards are out
            there" + distinct holders. Neutral (cyan/blue): shards are a
            secondary currency, not money. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Shards held"
            value={fmtShards(economy.totalShardsHeld)}
            sub="live user holdings"
            icon={Wallet}
            accent="cyan"
          />
          <KpiTile
            label="Holders"
            value={formatNumber(economy.shardHolders)}
            sub="wallets with shards"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="In circulation"
            value={fmtShards(economy.totalShardsHeld)}
            sub="total out there"
            icon={Globe}
            accent="cyan"
          />
          <KpiTile
            label="Issued to users"
            value={fmtShards(economy.issuedToUsers)}
            sub={`granted · ${periodLabel.toLowerCase()}`}
            icon={Gift}
            accent="rose"
          />
          <KpiTile
            label="Net house flow"
            value={fmtShards(economy.netHouse)}
            sub={
              economy.netHouse >= 0
                ? "game flow · house up"
                : "game flow · house down"
            }
            icon={Scale}
            accent={economy.netHouse >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Active users"
            value={formatNumber(economy.activeUsers)}
            sub={periodLabel.toLowerCase()}
            icon={Activity}
            accent="purple"
          />
        </div>
      </div>
    </FadeIn>
  );
}

/**
 * Shard-pack opens — every opening of one of the dedicated SHARD packs
 * (Common / Uncommon / Rare). Each open costs SHARDS (the pack's shard_cost)
 * and rolls a CARD into inventory worth $X. Shows shards spent (house in) +
 * the real $ card value pulled (house out), a per-pack breakdown, and a
 * paginated feed of individual opens.
 *
 * Active-timeframe-only: the active window + active page are parsed from the
 * URL and fetched in ONE keyed Suspense boundary — no eager preload of the
 * other windows/pages. Heavy read is cached per (period, page, perPage) and
 * wrapped in safeQuery so a slow/failed read degrades to a fallback tile
 * instead of hanging the segment.
 *
 * UNITS/POV: two never-summed quantities. SHARDS SPENT = the wager currency
 * the house takes in — shards are NOT money, rendered neutral (cyan). CARD
 * VALUE ($) = the real dollars the house pays out as the rolled card (house
 * cost) = rose. There is NO shard payout — shard packs return a card, not
 * shards.
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
      totalShardsSpent: 0,
      avgShardsPerOpen: 0,
      totalCardValueUsd: 0,
      totalCardCount: 0,
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
          No shard-pack schema on this database
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          The connected database has no{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
            packs
          </code>{" "}
          /{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
            game_sessions
          </code>{" "}
          tables, so shard-pack opens aren&apos;t available here. Switch to a
          database with the game schema (dev) to see shard-pack activity.
        </p>
      </div>
    );
  }

  const { summary, feed } = result;

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={PackageOpen}
        title={
          <span className="flex items-center gap-2">
            Shard-pack opens
            <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {periodLabel}
            </span>
          </span>
        }
      />

      {/* KPI strip — opens/openers are neutral readouts (cyan/blue). Shards
          spent = the wager currency the house takes in; shards are NOT money,
          rendered neutral (cyan). Card value pulled = the only money figure:
          real dollars the house pays out as the rolled card → rose (house
          cost), labelled "$", never summed with shards. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
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
          label="Shards spent"
          value={fmtShards(summary.totalShardsSpent)}
          sub="cost to open · house in"
          icon={ArrowDownLeft}
          accent="cyan"
        />
        <KpiTile
          label="Avg per open"
          value={fmtShards(summary.avgShardsPerOpen)}
          sub="shards"
          icon={Gem}
          accent="cyan"
        />
        {/* THE USD tile — real dollars the house paid out as cards through
            shard-pack opens. This is the only money figure in the strip:
            rose (house cost), labelled with "$", never summed with shards. */}
        <KpiTile
          label="Card value pulled"
          value={formatCurrency(summary.totalCardValueUsd)}
          sub={`real $ out · ${formatNumber(summary.totalCardCount)} card${summary.totalCardCount === 1 ? "" : "s"}`}
          icon={CreditCard}
          accent="rose"
        />
      </div>

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
    </div>
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
  const period: ShardOpensPeriod = "all";
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
          subtitle="The shard economy + every opening of the dedicated shard packs (Common / Uncommon / Rare) — the shards each open costs plus the real $ value of the card it pulled (the money the house pays out)."
        />
      </PageHero>

      {/* Shard economy overview (Part A). Own Suspense keyed on PERIOD only —
          it is window-scoped (independent of page/perPage), so paginating the
          opens feed doesn't re-fetch it. Active-Timeframe-Only: only the
          active window's economy is fetched (cache lives in getCoinsEconomy). */}
      <Suspense
        key={`economy|${period}`}
        fallback={
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
                />
              ))}
            </div>
            <div className="h-40 animate-pulse rounded-2xl border bg-muted/30" />
          </div>
        }
      >
        <EconomyOverviewContent period={period} />
      </Suspense>

      <Suspense
        key={suspenseKey}
        fallback={
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
              {Array.from({ length: 8 }).map((_, i) => (
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
