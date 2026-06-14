import { Suspense } from "react";
import {
  Gem,
  Users,
  ArrowDownLeft,
  PackageOpen,
  Globe,
  Coins,
  CreditCard,
  Sparkles,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { formatNumber, formatCurrency } from "@/lib/utils/format";
import {
  KpiTile,
  MetricTile,
  StatPanel,
  PanelRow,
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
  getShardGivenOut,
  shardOpensPeriodLabel,
  type ShardOpensPeriod,
  type ShardGivenOutResult,
} from "@/lib/queries/shard-pack-opens";
import { ShardOpensDataTable } from "./opens-data-table";
import { ShardEconomyCharts } from "./shard-economy-charts";

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
 * Shard ECONOMY OVERVIEW (Part A) — SHARDS ONLY. The live integer-shard supply
 * snapshot, the TRUE "shards given out" headline (held + spent on opens), and
 * the only real shard time-series: shards SPENT on shard-pack opens over time.
 *
 * NO COIN DATA on this page (owner request): `coin_transactions` is a SEPARATE
 * USD-pegged currency and is intentionally NOT surfaced here. All figures are
 * read from `getShardGivenOut` (Σ `balances.shards` + Σ `packs.shard_cost`
 * over shard-pack opens) — the integer SHARD currency only.
 *
 * UNIT: integer SHARDS, never USD. Shards are a NEUTRAL secondary wager
 * currency, so supply/holders/spent are neutral readouts (cyan / blue) — never
 * a House-POV money colour and never a "$" figure.
 *
 * SCOPE: staff (admin/support) + the `excluded_users` blacklist are dropped
 * from the supply, holders, spent and daily series inside `getShardGivenOut`
 * (consistent with the opens section below), so an excluded/internal account
 * can never inflate the "shards given out" headline.
 */
async function EconomyOverviewContent() {
  // ONE bounded + cached read: the TRUE integer-SHARD snapshot — held (Σ
  // balances.shards) + spent (Σ pack.shard_cost over opens) = givenOut, plus
  // the daily shards-spent series. No coin ledger is touched here.
  const { data: givenOut } = await safeQuery<ShardGivenOutResult>(
    () => getShardGivenOut(),
    null,
    "rewards.shard-opens.given-out",
    REWARD_QUERY_TIMEOUT_MS,
  );

  // Read degraded (game schema absent or timeout): hide the overview rather
  // than show a broken panel — the opens section renders its own degrade
  // message.
  if (!givenOut) return null;

  // Total lifetime opens, derived from the same daily shard series (no extra
  // read) — a shard-native readout for the supply grid.
  const lifetimeOpens = givenOut.daily.reduce((sum, d) => sum + d.opens, 0);

  return (
    <FadeIn>
      <div className="space-y-4">
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

        {/* ── HEADLINE: shards given out ──────────────────────────────────
            The number the owner wants, front and centre, in real SHARD units
            (integer). Shards are a neutral secondary currency (not money) →
            cyan, never a House-POV money colour. Reconciles transparently:
            given out = out there now (held) + spent on opens. */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <StatPanel
            title={
              <span className="flex items-center gap-2">
                Shards given out
                <span className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-600 dark:text-cyan-400">
                  shards
                </span>
              </span>
            }
            icon={Sparkles}
            accent="cyan"
          >
            <p className="text-3xl font-bold tracking-tight tabular-nums text-cyan-600 dark:text-cyan-400 sm:text-4xl">
              {formatNumber(givenOut.givenOut)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              total shards ever issued · still held + spent on opens
            </p>
            <div className="mt-3 space-y-0.5 border-t pt-3">
              <PanelRow
                label="Out there now (held)"
                value={formatNumber(givenOut.held)}
              />
              <PanelRow
                label="Spent on shard-pack opens"
                value={formatNumber(givenOut.spent)}
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Shards have no mint ledger, so &ldquo;given out&rdquo; is
              reconstructed from where they live: still in wallets (held) plus
              the only place they&apos;re spent (opening shard packs). Integer
              shards — never USD.
            </p>
          </StatPanel>

          <div className="grid grid-cols-2 gap-3 self-start">
            <MetricTile
              label="Out there now"
              value={formatNumber(givenOut.held)}
              sub="real-customer supply · live"
              icon={Globe}
              accent="cyan"
            />
            <MetricTile
              label="Holders"
              value={formatNumber(givenOut.holders)}
              sub="customer wallets holding shards"
              icon={Users}
              accent="blue"
            />
            <MetricTile
              label="Spent on opens"
              value={formatNumber(givenOut.spent)}
              sub="shards burned opening packs"
              icon={ArrowDownLeft}
              accent="cyan"
            />
            <MetricTile
              label="Lifetime opens"
              value={formatNumber(lifetimeOpens)}
              sub="shard-pack opens"
              icon={PackageOpen}
              accent="cyan"
            />
          </div>
        </div>

        {/* ── Shard flow over time ────────────────────────────────────────
            The only real shard time-series that exists: shards SPENT on
            shard-pack opens per day (Σ pack.shard_cost). Shards have no
            mint/earn ledger, so there is no "shards minted over time" line to
            draw — only this spend series is real. Integer shards, neutral
            cyan, never USD. */}
        <ShardEconomyCharts daily={givenOut.daily} />
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
 * SCOPE: staff (admin/support) + the `excluded_users` blacklist are dropped
 * from every figure (opens, openers, shards spent, card $ value, per-pack
 * breakdown and the feed) — the same population filter the `getTopOpenedPacks24h`
 * opens analogue uses. This is an activity/audit surface, so creators are NOT
 * dropped wholesale here (that is reserved for the customer GGR/NGR money
 * layer); the consistent page rule is staff + blacklist.
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-4">
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

      {/* Shard economy overview (Part A) — SHARDS ONLY. Window-independent
          (the given-out snapshot + daily shard-spent series don't depend on
          page/perPage), so paginating the opens feed doesn't re-fetch it. The
          365d-capped reads + caching live in getShardGivenOut. */}
      <Suspense
        key="shard-economy"
        fallback={
          <div className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
              <div className="h-[220px] animate-pulse rounded-2xl border bg-muted/30" />
              <div className="grid grid-cols-2 gap-3 self-start">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[88px] animate-pulse rounded-xl border bg-muted/30"
                  />
                ))}
              </div>
            </div>
            <div className="h-[260px] animate-pulse rounded-2xl border bg-muted/30" />
          </div>
        }
      >
        <EconomyOverviewContent />
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
