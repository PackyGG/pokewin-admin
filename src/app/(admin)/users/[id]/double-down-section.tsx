"use client";

/**
 * Double Down history section for the user-detail Gaming tab.
 *
 * Surfaces THIS user's Double Down rounds (gamble-your-battle-winnings) as a
 * log + a compact summary: rounds, win-rate, total staked vs paid out, and the
 * net the house kept on this user.
 *
 * House-POV (CLAUDE.md, STRICT): a round is colored from the HOUSE's view —
 *   • WIN  (user kept 90% of winnings) = house COST   → 🔴 rose (the payout)
 *   • LOSE (user forfeited winnings)    = house GAIN   → 🟢 emerald
 *   • the per-round house edge cut       = house revenue → 🟢 emerald
 *   • net staked − paid out (house-kept on this user) → emerald if ≥ 0.
 *
 * Streamed-band contract (mirrors ShardWinningsSection):
 *   • null    → query not kicked for the active tab (Active-Timeframe-Only) →
 *               skeleton card.
 *   • r.error → visible amber band error (a load failure ≠ an empty history).
 *   • 0 rounds → renders nothing (Gaming tab stays focused on actual activity).
 *
 * The read is the INDEXED per-user lookup getUserDoubleDownHistory
 * ((user_id,status) index → Bitmap Index Scan), kicked ONLY when the Gaming
 * tab is active so it never extends the page's initial load.
 */

import { use } from "react";
import { Dices } from "lucide-react";
import { SectionHeading, StatPanel } from "@/components/modern-panels";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard } from "@/components/ux";
import { RelativeTime } from "@/components/relative-time";
import {
  DoubleDownResultBadge,
  DoubleDownStatusBadge,
} from "@/components/double-down/dd-badges";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type { UserDoubleDownHistory } from "@/lib/queries/double-down-shared";

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function DoubleDownSection({
  doubleDownPromise,
}: {
  doubleDownPromise: Promise<SafeQueryResult<UserDoubleDownHistory>> | null;
}) {
  if (!doubleDownPromise) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Dices} title="Double Down" />
        <SkeletonCard lines={4} />
      </div>
    );
  }
  return <DoubleDownStreamed doubleDownPromise={doubleDownPromise} />;
}

function DoubleDownStreamed({
  doubleDownPromise,
}: {
  doubleDownPromise: Promise<SafeQueryResult<UserDoubleDownHistory>>;
}) {
  const r = use(doubleDownPromise);

  if (r.error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Dices} title="Double Down" />
        <InlineError
          compact
          title="Couldn't load Double Down history"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </div>
    );
  }

  const { summary, rows } = r.data;

  // Self-hide when the user has never had a Double Down round — the Gaming tab
  // stays focused on their actual activity.
  if (summary.totalRounds === 0) return null;

  const houseProfit = summary.netHousePnl >= 0;

  return (
    <div className="space-y-3">
      <SectionHeading icon={Dices} title="Double Down" />
      <p className="-mt-1 text-[11px] text-muted-foreground">
        Gamble-your-battle-winnings rounds — a win pays out a voucher, a loss
        forfeits the whole win. The house edge is in the win probability (~45%
        player), not a per-round cut. Colors are House-POV.
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Summary — the four headline metrics for this user: started rounds,
            win rate, total wager, House P&L (did WE make money on them). */}
        <StatPanel title="Summary" icon={Dices} accent="purple">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Started rounds
            </span>
            <span className="text-2xl font-bold tabular-nums text-purple-600 dark:text-purple-400">
              {formatNumber(summary.totalRounds)}
            </span>
          </div>
          <div className="space-y-1">
            <SummaryRow
              label="Win rate"
              value={`${pct(summary.winRate)} · ${formatNumber(summary.winCount)}W / ${formatNumber(summary.loseCount)}L`}
            />
            <SummaryRow
              label="Total wager"
              value={formatCurrency(summary.totalStaked)}
            />
            {/* House P&L on this user = forfeited − payouts. Profit → emerald,
                loss → rose, with sign + label. */}
            <SummaryRow
              label="House P&L"
              value={`${houseProfit ? "+" : "−"}${formatCurrency(Math.abs(summary.netHousePnl))} · ${houseProfit ? "profit" : "loss"}`}
              valueClassName={
                houseProfit
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
              }
            />
          </div>
        </StatPanel>

        {/* Recent rounds log — newest first, House-POV result + amounts. */}
        <StatPanel title="Recent rounds" icon={Dices} accent="purple">
          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No recent Double Down rounds.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <DoubleDownResultBadge result={w.result} />
                    <DoubleDownStatusBadge status={w.status} />
                    <span className="text-muted-foreground">
                      <RelativeTime date={w.createdAt} />
                    </span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    {/* Staked — neutral. */}
                    <span className="text-muted-foreground">
                      {formatCurrency(w.stakedUsd)}
                    </span>
                    {/* Payout on a win = house cost → rose. */}
                    {w.result === "win" && w.payoutUsd != null ? (
                      <span className="font-semibold text-rose-600 dark:text-rose-400">
                        +{formatCurrency(w.payoutUsd)}
                      </span>
                    ) : w.result === "lose" ? (
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                        −{formatCurrency(w.stakedUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </StatPanel>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={
          valueClassName
            ? `shrink-0 font-bold tabular-nums ${valueClassName}`
            : "shrink-0 font-bold tabular-nums text-purple-600 dark:text-purple-400"
        }
      >
        {value}
      </span>
    </div>
  );
}
