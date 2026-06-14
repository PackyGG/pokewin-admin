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

        {/* KPI strip — secondary-currency GAME flow over the active window.
            House-POV: spent = wagers the house takes in (emerald); earned =
            game wins paid out to users (rose); net house = spent − earned,
            GAME FLOW ONLY (house-funded issuance is excluded and shown
            separately below). Emerald when positive / house up, rose when
            negative / house down. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Shards wagered"
            value={formatCoins(stats.spent)}
            sub={periodLabel}
            icon={ArrowDownLeft}
            accent="emerald"
          />
          <KpiTile
            label="Game wins paid"
            value={formatCoins(stats.earned)}
            sub="won in games"
            icon={ArrowUpRight}
            accent="rose"
          />
          <KpiTile
            label="Net house flow"
            value={formatCoins(stats.netHouse)}
            sub={stats.netHouse >= 0 ? "game flow · house up" : "game flow · house down"}
            icon={Scale}
            accent={stats.netHouse >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="Issued to users"
            value={formatCoins(stats.issuedToUsers)}
            sub="house-funded grants"
            icon={Gift}
            accent="rose"
          />
        </div>

        {/* Active-users / volume row — secondary metrics under the flow KPIs. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiTile
            label="Active users"
            value={formatNumber(stats.activeUsers)}
            sub={`${formatNumber(stats.txCount)} transactions`}
            icon={Users}
            accent="cyan"
          />
          <KpiTile
            label="Currency issued"
            value={formatCoins(stats.issuedToUsers)}
            sub="minted grants (not game flow)"
            icon={Gem}
            accent="rose"
          />
        </div>

        {/* Daily earned-vs-spent trend. */}
        <StatPanel title="Daily flow" icon={LineChart} accent="cyan">
          <CoinsTrendChart daily={stats.daily} />
        </StatPanel>

        <div className="grid gap-3 lg:grid-cols-2">
          {/* Gross flow by category — every coin_transactions.type rolled up.
              These are GROSS per-type totals (one side of the flow each), NOT
              net: a game's bet leg and win leg are separate rows, and grants
              are a third (issuance) line. Read net game flow off "Net house
              flow" above, never by eyeballing one row. Issuance rows are
              tagged so they aren't mistaken for game payouts. */}
          <StatPanel title="Gross flow by category" icon={Coins} accent="cyan">
            {stats.categories.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No coin/shard activity in {periodLabel.toLowerCase()}.
              </p>
            ) : (
              <div className="space-y-0.5">
                {stats.categories.map((cat) => (
                  <PanelRow
                    key={cat.type}
                    label={`${cat.label}${cat.isIssuance ? " · issuance" : ""} · ${formatNumber(cat.count)} tx · ${formatNumber(cat.users)} ${cat.users === 1 ? "user" : "users"}`}
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
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                  Gross per-type totals (each row is one side of the flow), not
                  net. &ldquo;Issuance&rdquo; rows are house-minted grants, kept
                  out of the net house game-flow figure above.
                </p>
              </div>
            )}
          </StatPanel>

          {/* House signals + sustainability read. The sustainability verdict
              is GAME FLOW only (wagers vs game wins); house-funded issuance is
              broken out as its own line so a healthy economy isn't read as
              unsustainable just because the house minted coins. */}
          <StatPanel title="House signals" icon={Gift} accent="purple">
            <PanelRow
              label="Shards wagered (house in)"
              value={formatCoins(stats.spent)}
              valueClassName="text-emerald-600 dark:text-emerald-400"
            />
            <PanelRow
              label="Game wins paid (house out)"
              value={formatCoins(stats.earned)}
              valueClassName="text-rose-600 dark:text-rose-400"
            />
            <div className="mt-2 border-t pt-2">
              <PanelRow
                label="Net house · game flow (wagered − won)"
                value={formatCoins(stats.netHouse)}
                valueClassName={
                  stats.netHouse >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
            </div>
            <div className="mt-2 border-t pt-2">
              <PanelRow
                label="Currency issued (house-funded grants)"
                value={
                  <span className="text-rose-600 dark:text-rose-400">
                    {stats.issuedToUsers > 0 ? "+" : ""}
                    {formatCoins(stats.issuedToUsers)}
                  </span>
                }
                valueClassName="text-rose-600 dark:text-rose-400"
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              {stats.netHouse >= 0 ? (
                <>
                  On game flow, users net <span className="font-medium">wagered</span>{" "}
                  more coins/shards than games paid out — the economy is{" "}
                  <span className="text-emerald-600 dark:text-emerald-400">
                    self-funding
                  </span>{" "}
                  this window.
                </>
              ) : (
                <>
                  On game flow, games{" "}
                  <span className="text-rose-600 dark:text-rose-400">
                    paid out
                  </span>{" "}
                  more than users wagered this window.
                </>
              )}{" "}
              Issuance ({formatCoins(stats.issuedToUsers)} minted grants) is
              house-funded and shown separately, not folded into game flow.
              Figures are in shards/coins, not USD.
            </p>
          </StatPanel>
        </div>
      </div>
    </div>
  );
}
