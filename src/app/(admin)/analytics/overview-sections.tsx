import {
  ArrowDownRight,
  ArrowUpRight,
  Coins,
  Layers,
  Users,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { AnalyticsData } from "@/lib/queries/analytics";
import type { PackBattlePnlWindows } from "@/lib/queries/pnl";
import type { UserLeaderRow } from "@/lib/queries/analytics-top";

/**
 * Presentational sections for the /analytics Overview.
 *
 * Server components on purpose — every input is already-resolved plain data,
 * so there is no client bundle and no function prop crossing the RSC
 * boundary. The tab does the fetching; this file only decides how the money
 * reads.
 *
 * HOUSE POV throughout (CLAUDE.md): a number that is good for us is emerald,
 * a number that is good for the player is rose. So house profit positive =
 * emerald, a cost = rose, and player winnings = rose.
 */

/** House-POV colour for a signed house-perspective amount. */
function houseTone(value: number): string {
  if (value > 0) return "text-emerald-500";
  if (value < 0) return "text-rose-500";
  return "text-muted-foreground";
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatCurrency(value)}`;
}

// ─── 1. The number ────────────────────────────────────────────────────

/**
 * The headline: what the house actually made this period, and the ladder it
 * comes from. Deposits minus withdrawals is the cash that moved; the three
 * liability terms are what we still owe players (their balance, their cards,
 * their unclaimed vouchers). Subtract those and you have real profit, not
 * cash-in-the-door.
 */
export function HeadlineSection({ data }: { data: AnalyticsData }) {
  const b = data.realizedProfitBreakdown;
  const netCash = b.totalDeposits - b.totalWithdrawals;
  const liabilities = b.userBalance + b.inventory + b.vouchers + b.unclaimedRakeback;

  const ladder: { label: string; value: number; hint: string }[] = [
    { label: "Deposits", value: b.totalDeposits, hint: "cash in" },
    { label: "Withdrawals", value: -b.totalWithdrawals, hint: "cash out" },
    { label: "Player balances", value: -b.userBalance, hint: "we owe" },
    { label: "Card inventory", value: -b.inventory, hint: "we owe" },
    { label: "Vouchers", value: -b.vouchers, hint: "we owe" },
    {
      label: "Unclaimed rakeback",
      value: -b.unclaimedRakeback,
      hint: "we owe",
    },
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      {/* The one number, big. */}
      <div className="rounded-xl border bg-card p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          House profit
        </p>
        <p
          className={cn(
            "mt-1 text-3xl font-bold tabular-nums tracking-tight sm:text-4xl",
            houseTone(data.realizedProfit),
          )}
        >
          {signed(data.realizedProfit)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Cash in minus cash out, minus everything we still owe players.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              GGR
            </p>
            <p className="text-lg font-semibold tabular-nums text-emerald-500">
              {formatCurrency(data.ggr)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              wager − gaming payouts
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              NGR
            </p>
            <p className="text-lg font-semibold tabular-nums text-emerald-500">
              {formatCurrency(data.ngr)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              GGR − reward cost
            </p>
          </div>
        </div>
      </div>

      {/* The ladder that produces it. */}
      <div className="rounded-xl border bg-card p-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          How it adds up
        </p>
        <div className="mt-2 divide-y">
          {ladder.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-3 py-1.5"
            >
              <span className="text-sm">
                {row.label}
                <span className="ml-1.5 text-[11px] text-muted-foreground">
                  {row.hint}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 text-sm font-medium tabular-nums",
                  houseTone(row.value),
                )}
              >
                {signed(row.value)}
              </span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3 pt-2">
            <span className="text-sm font-semibold">House profit</span>
            <span
              className={cn(
                "shrink-0 text-sm font-bold tabular-nums",
                houseTone(data.realizedProfit),
              )}
            >
              {signed(data.realizedProfit)}
            </span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Net cash moved {signed(netCash)} · outstanding liability{" "}
          {formatCurrency(liabilities)}
        </p>
      </div>
    </div>
  );
}

// ─── 2. Cost stack ────────────────────────────────────────────────────

const COST_LEGS = [
  { key: "rewardRakeback", label: "Rakeback" },
  { key: "rewardSignupPacks", label: "Signup packs" },
  { key: "rewardLeaderboard", label: "Leaderboards" },
  { key: "rewardRain", label: "Rain" },
  { key: "rewardPromo", label: "Promos & bonuses" },
  { key: "rewardAffiliate", label: "Affiliate" },
] as const;

/**
 * What is eating the margin, ranked by dollars, each as a share of deposits.
 *
 * "% of deposits" is the number that actually decides whether a program is
 * affordable: a $40k rakeback bill means nothing until you know it came out
 * of $400k of deposits (10%) or $80k (50%).
 */
export function CostStackSection({ data }: { data: AnalyticsData }) {
  const deposits = data.realizedProfitBreakdown.totalDeposits;
  const legs = COST_LEGS.map((leg) => ({
    label: leg.label,
    amount: data.daily.reduce((sum, d) => sum + (d[leg.key] ?? 0), 0),
  }))
    .filter((l) => l.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  const total = legs.reduce((sum, l) => sum + l.amount, 0);
  const max = legs.length > 0 ? Math.max(...legs.map((l) => l.amount)) : 0;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Coins} title="Where the money leaks" />
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm">
            <span className="text-lg font-bold tabular-nums text-rose-500">
              {formatCurrency(total)}
            </span>{" "}
            <span className="text-muted-foreground">
              paid out in rewards this period
            </span>
          </p>
          <p className="text-sm tabular-nums text-muted-foreground">
            {pct(total, deposits).toFixed(1)}% of {formatCurrency(deposits)}{" "}
            deposits
          </p>
        </div>

        {legs.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No reward cost booked in this period.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {legs.map((leg) => (
              <div key={leg.label} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{leg.label}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-medium text-rose-500">
                      {formatCurrency(leg.amount)}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {pct(leg.amount, deposits).toFixed(1)}% of deposits
                    </span>
                  </span>
                </div>
                {/* Bar is relative to the BIGGEST leg, so the ranking reads at
                    a glance; the % text stays absolute against deposits. */}
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-rose-500/70"
                    style={{ width: `${max > 0 ? (leg.amount / max) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 3. Game mix + real hold ──────────────────────────────────────────

/**
 * What they play, and what we actually keep from it.
 *
 * Hold = house profit ÷ wager for the mode; RTP is its mirror (what went
 * back to players). These are MEASURED, not the configured edge — the point
 * is to see when a mode runs hot against the model.
 *
 * The pack/battle windows are fixed (24h / 7d / lifetime) because that's what
 * the pure-margin query computes; the label says so rather than pretending
 * they follow the page period.
 */
export function GameMixSection({
  data,
  pure,
}: {
  data: AnalyticsData;
  pure: PackBattlePnlWindows | null;
}) {
  const totalWager = data.packWager + data.battleWager + data.upgraderWager;
  const modes = [
    { label: "Packs", wager: data.packWager },
    { label: "Battles", wager: data.battleWager },
    { label: "Upgrader", wager: data.upgraderWager },
  ].sort((a, b) => b.wager - a.wager);

  const holdRows = pure
    ? ([
        { label: "Packs · 24h", row: pure.h24, key: "pack" },
        { label: "Packs · 7d", row: pure.d7, key: "pack" },
        { label: "Packs · lifetime", row: pure.all, key: "pack" },
        { label: "Battles · 24h", row: pure.h24, key: "battle" },
        { label: "Battles · 7d", row: pure.d7, key: "battle" },
        { label: "Battles · lifetime", row: pure.all, key: "battle" },
      ] as const)
    : [];

  return (
    <div className="space-y-3">
      <SectionHeading icon={Layers} title="What they play, what we keep" />
      <div className="grid gap-3 lg:grid-cols-2">
        {/* Wager mix for the selected period. */}
        <div className="rounded-xl border bg-card p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Wager mix · {formatCurrency(totalWager)}
          </p>
          <div className="mt-3 space-y-2">
            {modes.map((m) => (
              <div key={m.label} className="space-y-1">
                <div className="flex items-baseline justify-between text-sm">
                  <span>{m.label}</span>
                  <span className="tabular-nums">
                    {formatCurrency(m.wager)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {pct(m.wager, totalWager).toFixed(1)}%
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-blue-500/70"
                    style={{ width: `${pct(m.wager, totalWager)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Measured hold / RTP per mode. */}
        <div className="rounded-xl border bg-card p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Measured hold — real money only
          </p>
          {!pure ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Pure-margin read unavailable — refresh to retry.
            </p>
          ) : (
            <div className="mt-2 divide-y">
              {holdRows.map(({ label, row, key }) => {
                const wager = key === "pack" ? row.packWager : row.battleWager;
                const pnl = key === "pack" ? row.packPnl : row.battlePnl;
                const hold = wager > 0 ? (pnl / wager) * 100 : 0;
                return (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className={cn("font-medium", houseTone(pnl))}>
                        {hold.toFixed(2)}% hold
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {(100 - hold).toFixed(2)}% RTP ·{" "}
                        {formatCurrency(wager)} wagered
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Fixed windows — excludes creator wagers and borrowed-balance play,
            so this is the margin on real money.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── 4. Concentration ─────────────────────────────────────────────────

/**
 * How much of the period's deposits come from a handful of accounts.
 *
 * A house that is 60% one whale is not the same business as one that is 5%
 * its biggest depositor, even at identical revenue — this is the line that
 * says which one we are.
 */
export function ConcentrationSection({
  deposits,
  top,
  windowLabel,
}: {
  deposits: number;
  top: UserLeaderRow[] | null;
  /** null when the leaderboard window can't be aligned to the page period. */
  windowLabel: string | null;
}) {
  return (
    <div className="space-y-3">
      <SectionHeading icon={Users} title="Who the revenue depends on" />
      <div className="rounded-xl border bg-card p-4">
        {!windowLabel || !top ? (
          <p className="text-sm text-muted-foreground">
            Depositor concentration is computed over 7d, 30d or lifetime —
            switch the period filter to one of those to see it. (Mixing a 7-day
            leaderboard into a 90-day deposit total would just be a wrong
            percentage.)
          </p>
        ) : (
          (() => {
            const top1 = top[0]?.amount ?? 0;
            const top5 = top.slice(0, 5).reduce((s, r) => s + r.amount, 0);
            const top10 = top.slice(0, 10).reduce((s, r) => s + r.amount, 0);
            const tiers = [
              { label: "Top depositor", value: top1 },
              { label: "Top 5", value: top5 },
              { label: "Top 10", value: top10 },
            ];
            return (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {tiers.map((t) => (
                    <div key={t.label}>
                      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        {t.label}
                      </p>
                      <p className="text-xl font-bold tabular-nums">
                        {pct(t.value, deposits).toFixed(1)}%
                      </p>
                      <p className="text-[11px] tabular-nums text-muted-foreground">
                        {formatCurrency(t.value)} deposited
                      </p>
                    </div>
                  ))}
                </div>
                {/* Scope note, not a disclaimer for its own sake: the
                    leaderboard drops staff AND creator accounts, while the
                    deposit total keeps creators — so a creator's deposits sit
                    in the denominator only. That makes every share here a
                    FLOOR. Better to say so than to quietly print a number
                    that's a percentage point light. */}
                <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
                  Share of {formatCurrency(deposits)} deposits, {windowLabel}.
                  Top depositors exclude staff and creator accounts; the
                  deposit total doesn&apos;t — so these are floors.
                </p>
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}

// ─── 5. Per-day money table ───────────────────────────────────────────

/**
 * One row per day, the numbers you'd otherwise rebuild in a spreadsheet:
 * deposits in, wager, GGR, what the rewards cost, NGR, and the reward bill as
 * a share of that day's deposits.
 *
 * Newest first — the last few days are what anyone opens this for.
 */
export function DailyMoneyTable({ data }: { data: AnalyticsData }) {
  const rows = [...data.daily].reverse();
  const totals = rows.reduce(
    (acc, d) => {
      const rewards =
        d.rewardRakeback +
        d.rewardSignupPacks +
        d.rewardLeaderboard +
        d.rewardRain +
        d.rewardPromo +
        d.rewardAffiliate;
      return {
        deposits: acc.deposits + d.totalDeposit,
        wager: acc.wager + d.packWager + d.battleWager,
        ggr: acc.ggr + d.ggr,
        rewards: acc.rewards + rewards,
        ngr: acc.ngr + d.ngr,
      };
    },
    { deposits: 0, wager: 0, ggr: 0, rewards: 0, ngr: 0 },
  );

  return (
    <div className="space-y-3">
      <SectionHeading icon={ArrowUpRight} title="Day by day" />
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-right font-medium">Deposits</th>
              <th className="px-3 py-2 text-right font-medium">Wager</th>
              <th className="px-3 py-2 text-right font-medium">GGR</th>
              <th className="px-3 py-2 text-right font-medium">Rewards</th>
              <th className="px-3 py-2 text-right font-medium">NGR</th>
              <th className="px-3 py-2 text-right font-medium">Rwd % dep</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((d) => {
              const rewards =
                d.rewardRakeback +
                d.rewardSignupPacks +
                d.rewardLeaderboard +
                d.rewardRain +
                d.rewardPromo +
                d.rewardAffiliate;
              const share = pct(rewards, d.totalDeposit);
              return (
                <tr key={d.date} className="hover:bg-accent/30">
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted-foreground">
                    {d.date}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatCurrency(d.totalDeposit)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(d.packWager + d.battleWager)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right tabular-nums",
                      houseTone(d.ggr),
                    )}
                  >
                    {formatCurrency(d.ggr)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-rose-500">
                    {formatCurrency(rewards)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right tabular-nums",
                      houseTone(d.ngr),
                    )}
                  >
                    {formatCurrency(d.ngr)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right tabular-nums",
                      // Over half a day's deposits going back out as rewards
                      // is worth seeing without reading the number.
                      share > 50 ? "text-rose-500" : "text-muted-foreground",
                    )}
                  >
                    {d.totalDeposit > 0 ? `${share.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t bg-muted/30 font-medium">
            <tr>
              <td className="px-3 py-2 text-left">Period</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCurrency(totals.deposits)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {formatCurrency(totals.wager)}
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right tabular-nums",
                  houseTone(totals.ggr),
                )}
              >
                {formatCurrency(totals.ggr)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-rose-500">
                {formatCurrency(totals.rewards)}
              </td>
              <td
                className={cn(
                  "px-3 py-2 text-right tabular-nums",
                  houseTone(totals.ngr),
                )}
              >
                {formatCurrency(totals.ngr)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                {totals.deposits > 0
                  ? `${pct(totals.rewards, totals.deposits).toFixed(1)}%`
                  : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─── 6. Traffic strip ─────────────────────────────────────────────────

/** Signups / active players / cash movement, small — context, not headline. */
export function TrafficStrip({ data }: { data: AnalyticsData }) {
  const b = data.realizedProfitBreakdown;
  const tiles = [
    {
      label: "Deposits",
      value: formatCurrency(b.totalDeposits),
      tone: "text-emerald-500",
      icon: ArrowDownRight,
    },
    {
      label: "Withdrawals",
      value: formatCurrency(b.totalWithdrawals),
      tone: "text-rose-500",
      icon: ArrowUpRight,
    },
    {
      label: "Active players",
      value: formatNumber(data.uniqueVisitors),
      tone: "",
      icon: Users,
    },
    {
      label: "New signups",
      value: formatNumber(data.newSignups),
      tone: "",
      icon: Users,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="h-full rounded-lg border bg-card px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <t.icon className="size-3.5" />
            {t.label}
          </p>
          <p className={cn("mt-1 text-xl font-bold tabular-nums", t.tone)}>
            {t.value}
          </p>
        </div>
      ))}
    </div>
  );
}
