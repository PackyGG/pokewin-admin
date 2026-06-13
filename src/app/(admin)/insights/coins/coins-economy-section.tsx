import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Gem,
  Gift,
  LineChart,
  Scale,
  Users,
  Wallet,
} from "lucide-react";
import {
  KpiTile,
  MetricTile,
  PanelRow,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getCoinsEconomy,
  coinsPeriodLabel,
  type CoinsPeriod,
} from "@/lib/queries/insights-coins";
import { CoinsPeriodFilter } from "./period-filter";
import { CoinsTrendChart } from "./coins-trend-chart";

/**
 * Global coin & shard economy — the body of /insights/coins.
 *
 * Two layers:
 *   1. SUPPLY (no period) — live secondary-currency held in wallets: total
 *      shards + total coin balance + holder counts. Neutral cyan/purple
 *      (these are counts of a wager-earned currency, not USD).
 *   2. ECONOMY (active window only) — the coin_transactions flow: earned vs
 *      spent, net house flow, per-type breakdown, a daily trend chart, and
 *      a sustainability read.
 *
 * House-POV (secondary currency, label as wager-earned, NOT USD):
 *   - counts / balances → neutral cyan.
 *   - coins SPENT by users into games (house takes in) → emerald.
 *   - coins EARNED / GRANTED to users (house liability / cost) → rose.
 *
 * Active-timeframe-only: fetches just the active window. Degrades to a clear
 * "no coin/shard ledger on this database" panel when the connected DB lacks
 * `coin_transactions` (e.g. a prod game DB with no sweepstakes schema)
 * instead of crashing.
 */

/** Round + format a coin/shard amount; guards NaN/Infinity to "—". */
function formatCoins(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return formatNumber(Math.round(n));
}

export async function CoinsEconomySection({
  period,
}: {
  period: CoinsPeriod;
}) {
  const { data: stats } = await safeQuery(
    () => getCoinsEconomy(period),
    null,
    "insights.coins.economy",
    15_000,
  );

  const heading = (
    <SectionHeading
      icon={Coins}
      title="Coin & shard economy"
      action={<CoinsPeriodFilter />}
    />
  );

  if (!stats) {
    return (
      <div className="space-y-3">
        {heading}
        <TileErrorFallback
          label="Coin & shard economy"
          hint="The economy read failed — no data was changed. Try again."
          size="panel"
        />
      </div>
    );
  }

  if (!stats.available) {
    return (
      <div className="space-y-3">
        {heading}
        <div className="rounded-2xl border border-dashed bg-card/30 p-6 text-center">
          <Coins className="mx-auto size-7 text-muted-foreground/60" />
          <p className="mt-2 text-sm font-medium">
            No coin/shard ledger on this database
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            The connected database has no{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              coin_transactions
            </code>{" "}
            table, so the secondary-currency economy isn&apos;t available
            here. Switch to a database with the sweepstakes schema (dev) to see
            coin/shard activity.
          </p>
        </div>
      </div>
    );
  }

  const { supply } = stats;
  const periodLabel = coinsPeriodLabel(stats.period);

  return (
    <div className="space-y-6">
      {/* ── Supply snapshot (no period) ──────────────────────────────── */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Wallet} title="Currency supply" />
          {/* Neutral — these are counts of a wager-earned currency held in
              wallets, NOT a USD P&L. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Shards held"
              value={formatCoins(supply.totalShards)}
              sub={`${formatNumber(supply.shardHolders)} ${supply.shardHolders === 1 ? "holder" : "holders"}`}
              icon={Gem}
              accent="cyan"
            />
            <MetricTile
              label="Coin balance"
              value={formatCoins(supply.totalCoin)}
              sub={`${formatNumber(supply.coinHolders)} ${supply.coinHolders === 1 ? "holder" : "holders"}`}
              icon={Coins}
              accent="purple"
            />
            <KpiTile
              label="Shard holders"
              value={formatNumber(supply.shardHolders)}
              sub="wallets with shards"
              icon={Users}
              accent="cyan"
            />
            <KpiTile
              label="Coin holders"
              value={formatNumber(supply.coinHolders)}
              sub="wallets with coin balance"
              icon={Users}
              accent="purple"
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Shards &amp; coins are a secondary, wager-earned currency — these
            are live total wallet balances across every holder, not USD.
            Supply is a snapshot and ignores the period filter below.
          </p>
        </div>
      </FadeIn>

      {/* ── Economy (active window only) ─────────────────────────────── */}
      <div className="space-y-3">
        {heading}

        {/* KPI strip — secondary-currency flow over the active window.
            House-POV: spent = house takes in (emerald); earned = house pays
            out / user wins (rose); net house = spent − earned (emerald when
            positive / house up, rose when negative / house down). */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Shards spent"
            value={formatCoins(stats.spent)}
            sub={periodLabel}
            icon={ArrowDownLeft}
            accent="emerald"
          />
          <KpiTile
            label="Shards earned"
            value={formatCoins(stats.earned)}
            sub="paid out to users"
            icon={ArrowUpRight}
            accent="rose"
          />
          <KpiTile
            label="Net house flow"
            value={formatCoins(stats.netHouse)}
            sub={stats.netHouse >= 0 ? "house took in" : "house paid out"}
            icon={Scale}
            accent={stats.netHouse >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Active users"
            value={formatNumber(stats.activeUsers)}
            sub={`${formatNumber(stats.txCount)} transactions`}
            icon={Users}
            accent="cyan"
          />
        </div>

        {/* Daily earned-vs-spent trend. */}
        <StatPanel title="Daily flow" icon={LineChart} accent="cyan">
          <CoinsTrendChart daily={stats.daily} />
        </StatPanel>

        <div className="grid gap-3 lg:grid-cols-2">
          {/* Category breakdown — every coin_transactions.type rolled up. */}
          <StatPanel title="Usage by category" icon={Coins} accent="cyan">
            {stats.categories.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No coin/shard activity in {periodLabel.toLowerCase()}.
              </p>
            ) : (
              <div className="space-y-0.5">
                {stats.categories.map((cat) => (
                  <PanelRow
                    key={cat.type}
                    label={`${cat.label} · ${formatNumber(cat.count)} tx · ${formatNumber(cat.users)} ${cat.users === 1 ? "user" : "users"}`}
                    value={
                      <span
                        className={
                          cat.direction === "earned"
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-emerald-600 dark:text-emerald-400"
                        }
                      >
                        {cat.direction === "earned" ? "+" : "−"}
                        {formatCoins(cat.total)}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </StatPanel>

          {/* House signals + sustainability read. */}
          <StatPanel title="House signals" icon={Gift} accent="purple">
            <PanelRow
              label="Granted to users (admin)"
              value={
                <span className="text-rose-600 dark:text-rose-400">
                  {stats.grantedToUsers > 0 ? "+" : ""}
                  {formatCoins(stats.grantedToUsers)}
                </span>
              }
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <PanelRow
              label="Total shards spent (wagered)"
              value={formatCoins(stats.spent)}
              valueClassName="text-emerald-600 dark:text-emerald-400"
            />
            <PanelRow
              label="Total shards earned (won)"
              value={formatCoins(stats.earned)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <div className="mt-2 border-t pt-2">
              <PanelRow
                label="Net house (spent − earned)"
                value={formatCoins(stats.netHouse)}
                valueClassName={
                  stats.netHouse >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              {stats.netHouse >= 0 ? (
                <>
                  Users net <span className="font-medium">spent</span>{" "}
                  coins/shards into games this window — the economy is{" "}
                  <span className="text-emerald-600 dark:text-emerald-400">
                    sustainable
                  </span>{" "}
                  (house took in more than it paid out).
                </>
              ) : (
                <>
                  Users net <span className="font-medium">earned</span>{" "}
                  coins/shards this window — the house{" "}
                  <span className="text-rose-600 dark:text-rose-400">
                    paid out
                  </span>{" "}
                  more than it took in. Figures are in shards, not USD.
                </>
              )}
            </p>
          </StatPanel>
        </div>
      </div>
    </div>
  );
}
