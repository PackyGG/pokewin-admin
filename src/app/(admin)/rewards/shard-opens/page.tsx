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
  getShardEconomyOverview,
  parseShardOpensPeriod,
  shardOpensPeriodLabel,
  type ShardOpensPeriod,
  type ShardEconomyResult,
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

        {/* Flow breakdown for the window — earned (wins) vs spent (wagered)
            vs issued (grants). House-POV colors on the cash-adjacent legs. */}
        <StatPanel
          title={`Shard flow · ${periodLabel.toLowerCase()}`}
          icon={Coins}
          accent="cyan"
        >
          <div className="space-y-0.5">
            <PanelRow
              label="Shards wagered into games (house in)"
              value={`+${fmtShards(economy.spent)}`}
              valueClassName="text-emerald-600 dark:text-emerald-400"
            />
            <PanelRow
              label="Shards won back as game payouts (house out)"
              value={`-${fmtShards(economy.earned)}`}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Shards issued to users · grants (house out)"
              value={`-${fmtShards(economy.issuedToUsers)}`}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Net house game flow (wagered − won)"
              value={`${economy.netHouse >= 0 ? "+" : "-"}${fmtShards(Math.abs(economy.netHouse))}`}
              valueClassName={
                economy.netHouse >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }
            />
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Shards are a secondary, wager-earned currency — every figure here
              is in shards, never USD. &ldquo;Shards held&rdquo; /
              &ldquo;In circulation&rdquo; is the live supply across all wallets
              (a balance-sheet snapshot, not period-scoped). Issued grants are
              house-minted issuance and are kept OUT of the net house game flow
              (which is purely shards wagered − shards won).
            </p>
          </div>
        </StatPanel>
      </div>
    </FadeIn>
  );
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
      totalCardValueUsd: 0,
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

      {/* KPI strip — SHARDS (House-POV colored) PLUS the one USD tile (card
          value pulled, rose). spent = house in (emerald), won = house out
          (rose), net house = emerald/rose by sign. opens/openers/avg/edge are
          neutral readouts (cyan/amber/purple). The USD tile is the only money
          figure here and is kept visually distinct + labelled "$". */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
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
        {/* THE USD tile — real dollars the house paid out as cards through
            shard-pack opens. This is the only money figure in the strip:
            rose (house cost), labelled with "$", never summed with shards. */}
        <KpiTile
          label="Card value pulled"
          value={formatCurrency(summary.totalCardValueUsd)}
          sub="real $ out · cards"
          icon={CreditCard}
          accent="rose"
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
                  Figures here are in shards (a secondary, wager-earned
                  currency), not USD. Each row shows shards wagered (house in) ·
                  shards won (house out) · net house. Separately, the{" "}
                  <span className="text-rose-600 dark:text-rose-400">
                    real $ value of the cards
                  </span>{" "}
                  these opens rolled into inventory — the true money the house
                  pays out through the shard-pack mechanic — is shown as
                  &ldquo;Card value pulled&rdquo; above and per open in the feed
                  below.
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
          subtitle="The shard economy + every open of a pack bought with shards — shards spent/won (the wager currency) plus the real $ value of the cards each open pulled (the money the house pays out)."
          action={<OpensPeriodFilter />}
        />
      </PageHero>

      {/* Two-dimension note: shards are the wager currency in/out; the card $
          value is the real money the house pays out. The same Active-
          Timeframe-Only + safeQuery contract applies so a high-volume window
          degrades cleanly. */}
      <div className="flex items-start gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/5 px-4 py-2.5">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-cyan-500" />
        <p className="text-xs text-muted-foreground">
          Two units, never mixed.{" "}
          <span className="font-medium">Shards</span> are a secondary,
          wager-earned currency — the amount bet into / won back from an open
          (House-POV:{" "}
          <span className="text-emerald-600 dark:text-emerald-400">
            shards wagered
          </span>{" "}
          are taken in,{" "}
          <span className="text-rose-600 dark:text-rose-400">shards won</span>{" "}
          are a liability).{" "}
          <span className="font-medium">Card value ($)</span> is the{" "}
          <span className="text-rose-600 dark:text-rose-400">
            real money the house pays out
          </span>{" "}
          — the USD value of the card each open rolls into inventory, the true
          cost of the shard-pack mechanic. Shard figures and USD figures are
          shown distinctly and are never summed together.
        </p>
      </div>

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
            <TableSkeleton rows={Math.min(perPage, 10)} columns={7} />
            <PaginationSkeleton />
          </div>
        }
      >
        <OpensContent period={period} page={page} perPage={perPage} />
      </Suspense>
    </div>
  );
}
