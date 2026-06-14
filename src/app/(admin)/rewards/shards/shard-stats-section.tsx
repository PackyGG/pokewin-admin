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
 * neutrally (cyan/amber). The cash-adjacent signals follow the house rule:
 * coins users WIN in games (a house liability) read rose; coins users SPEND
 * (the house takes in) read emerald; house-funded ISSUANCE (deposit/admin
 * grants minted to users) reads rose and is kept SEPARATE from game flow —
 * it is not a bet vs payout, so it never drags the net house game-flow read.
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

      {/* KPI strip — secondary-currency GAME flow over the active window.
          House-POV: spent = wagers the house takes in (emerald); earned =
          game wins paid out (rose); net house = spent − earned, GAME FLOW
          ONLY (house-funded issuance excluded, shown separately). Emerald
          when positive / house up, rose when negative / house down. */}
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
          label="Active users"
          value={formatNumber(stats.activeUsers)}
          sub={`${formatNumber(stats.txCount)} transactions`}
          icon={Users}
          accent="cyan"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Gross flow by category — every coin_transactions.type rolled up.
            These are GROSS per-type totals (one side of the flow each), NOT
            net: a game's bet leg and win leg are separate rows, and grants
            are a third (issuance) line. Read net game flow off "Net house
            flow" above. Issuance rows are tagged so they aren't mistaken for
            game payouts. */}
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

        {/* House signals + sustainability read (GAME FLOW only; house-funded
            issuance broken out separately so a healthy economy isn't read as
            unsustainable just because the house minted coins). */}
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
            Coins/shards are a secondary, wager-earned currency — figures are
            in shards, not USD. Net house is GAME FLOW only:
            &ldquo;wagered&rdquo; (house takes in) minus game &ldquo;wins&rdquo;
            (house pays out). Issuance is house-minted grants, shown separately
            and never folded into game flow.
          </p>
        </StatPanel>
      </div>
    </div>
  );
}
