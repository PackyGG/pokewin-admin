import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Gift,
  Scale,
  Users,
} from "lucide-react";
import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getShardStats,
  shardStatsPeriodLabel,
  type ShardStatsPeriod,
} from "@/lib/queries/shard-stats";
import { ShardStatsPeriodFilter } from "./shard-stats-period-filter";

/**
 * Coin / shard economy usage stats for the /rewards/shards surface.
 *
 * Reads the `coin_transactions` ledger (the secondary-currency usage
 * trail behind shard/coin packs, upgrader, battles & rain) for the
 * SINGLE active window only — active-timeframe-only, no eager preload of
 * the other windows. Degrades to a clear "not on this DB" panel when the
 * connected DB lacks `coin_transactions` (e.g. the live prod game DB,
 * which has no sweepstakes schema yet) instead of crashing.
 *
 * House-POV note: coins/shards are a SECONDARY currency, wager-earned and
 * with no direct USD P&L on this surface, so the figures are presented
 * neutrally (cyan/amber). The two cash-adjacent signals follow the house
 * rule: coins users EARN (a house liability, like a user win) read rose;
 * coins users SPEND (the house takes in) read emerald; admin GRANTS of
 * coins to users (a gift, a house cost) read rose.
 */

/** Round + format a coin/shard amount; guards NaN/Infinity to "—". */
function formatCoins(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return formatNumber(Math.round(n));
}

export async function ShardStatsSection({
  period,
}: {
  period: ShardStatsPeriod;
}) {
  const { data: stats } = await safeQuery(
    () => getShardStats(period),
    null,
    "rewards.shards.stats",
    15_000,
  );

  const heading = (
    <SectionHeading
      icon={Coins}
      title="Coin & shard economy"
      action={<ShardStatsPeriodFilter />}
    />
  );

  if (!stats) {
    return (
      <div className="space-y-3">
        {heading}
        <TileErrorFallback
          label="Coin & shard economy"
          hint="The usage read failed — no data was changed. Try again."
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
            table, so secondary-currency usage stats aren&apos;t available
            here. Switch to a database with the sweepstakes schema (dev) to
            see coin/shard activity.
          </p>
        </div>
      </div>
    );
  }

  const periodLabel = shardStatsPeriodLabel(stats.period);

  return (
    <div className="space-y-3">
      {heading}

      {/* KPI strip — secondary-currency usage over the active window.
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

        {/* House-cost-adjacent signal: coins gifted to users by an admin. */}
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
            Coins/shards are a secondary, wager-earned currency — figures are
            in shards, not USD. &ldquo;Spent&rdquo; is the house taking shards
            in (wagers); &ldquo;earned&rdquo; is the house paying shards out
            (wins &amp; grants).
          </p>
        </StatPanel>
      </div>
    </div>
  );
}
