import { LineChart, TrendingDown, TrendingUp } from "lucide-react";

import { getCreatorPnl } from "@/lib/queries/creators";
import { SectionHeading, StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

const DISPLAYED_PERIODS: Array<{
  key: "24h" | "3d" | "7d" | "14d" | "30d";
  label: string;
  sub: string;
}> = [
  { key: "24h", label: "1d", sub: "Last 24 hours" },
  { key: "3d", label: "3d", sub: "Last 3 days" },
  { key: "7d", label: "7d", sub: "Last week" },
  { key: "14d", label: "2w", sub: "Last 2 weeks" },
  { key: "30d", label: "1m", sub: "Last month" },
];

/**
 * Per-creator House P&L panel for /creators/[userId]. Renders 5
 * mini-tiles (1d / 3d / 7d / 2w / 1m), each headlined with the
 * canonical balance-sheet House P&L for that window:
 *
 *   pnl = deposits − withdrawals − balanceChange − inventoryChange − voucherChange
 *
 * Same formula the dashboard's Lifetime P&L surface uses — just
 * evaluated as DELTAS over the window. Because lifetime P&L is
 * cash_in − cash_out − liability_now, the delta gives the actual
 * P&L change attributable to the window.
 *
 * Referred-user pool excludes admin / support / creator roles AND
 * the creator's own user_id, so other streamers' on-site activity
 * doesn't skew the per-creator number.
 *
 * House POV:
 *   pnl > 0 (emerald) — house made money on this creator's referrals
 *   pnl < 0 (rose)    — house lost money
 */
export async function CreatorPnlPanel({ userId }: { userId: string }) {
  const data = await getCreatorPnl(userId);

  // Map period key → row for O(1) lookup.
  const byPeriod = new Map(data.byPeriod.map((p) => [p.period, p]));

  return (
    <div className="space-y-3">
      <SectionHeading icon={LineChart} title="Affiliates PnL" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {DISPLAYED_PERIODS.map(({ key, label, sub }) => {
          const row = byPeriod.get(key);
          const pnl = row?.pnl ?? 0;
          const deposits = row?.deposits ?? 0;
          const withdrawals = row?.withdrawals ?? 0;
          const balanceChange = row?.balanceChange ?? 0;
          const inventoryChange = row?.inventoryChange ?? 0;
          const voucherChange = row?.voucherChange ?? 0;
          const isWin = pnl > 0;
          const isLoss = pnl < 0;
          const accent: "emerald" | "rose" | "blue" = isWin
            ? "emerald"
            : isLoss
              ? "rose"
              : "blue";
          return (
            <StatPanel
              key={key}
              title={label}
              icon={isWin ? TrendingUp : isLoss ? TrendingDown : LineChart}
              accent={accent}
            >
              <div className="space-y-1.5">
                <div
                  className={cn(
                    "text-xl font-bold tabular-nums leading-none",
                    isWin
                      ? "text-emerald-600 dark:text-emerald-400"
                      : isLoss
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground",
                  )}
                  title={`House P&L — ${sub}`}
                >
                  {pnl === 0 ? "—" : formatCurrency(pnl)}
                </div>
                <p className="text-[10px] text-muted-foreground">{sub}</p>
              </div>
              <div className="mt-3 space-y-0.5">
                {/* Deposits — cash-in from referred users (House gain) */}
                <PanelRow
                  label="Deposits"
                  value={deposits === 0 ? "—" : formatCurrency(deposits)}
                  valueClassName={
                    deposits > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ""
                  }
                />
                {/* Withdrawals — cash + cards leaving House (House loss) */}
                <PanelRow
                  label="Withdrawals"
                  value={
                    withdrawals === 0 ? "—" : formatCurrency(withdrawals)
                  }
                  valueClassName={
                    withdrawals > 0 ? "text-rose-600 dark:text-rose-400" : ""
                  }
                />
                {/* Balance change — net change in user balance liability.
                    Positive = user has more on-site balance now (we owe
                    more = House loss). */}
                <PanelRow
                  label="Balance Δ"
                  value={
                    balanceChange === 0
                      ? "—"
                      : `${balanceChange > 0 ? "+" : ""}${formatCurrency(balanceChange)}`
                  }
                  valueClassName={
                    balanceChange > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : balanceChange < 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : ""
                  }
                />
                {/* Inventory change — net change in unsold-card liability.
                    Positive = user has more cards on the books now. */}
                <PanelRow
                  label="Inventory Δ"
                  value={
                    inventoryChange === 0
                      ? "—"
                      : `${inventoryChange > 0 ? "+" : ""}${formatCurrency(inventoryChange)}`
                  }
                  valueClassName={
                    inventoryChange > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : inventoryChange < 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : ""
                  }
                />
                {/* Voucher change — net change in unclaimed-voucher
                    liability. Same sign convention. */}
                <PanelRow
                  label="Voucher Δ"
                  value={
                    voucherChange === 0
                      ? "—"
                      : `${voucherChange > 0 ? "+" : ""}${formatCurrency(voucherChange)}`
                  }
                  valueClassName={
                    voucherChange > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : voucherChange < 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : ""
                  }
                />
              </div>
            </StatPanel>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        House P&amp;L = deposits − withdrawals − balance Δ − inventory Δ −
        voucher Δ. Same canonical balance-sheet formula as Lifetime P&amp;L
        on the dashboard, evaluated as deltas over each window. Excludes
        admin / support / creator role accounts from the referred-user
        pool. Positive (emerald) = we made money. Excludes creator-side
        deal cost (commission, tips, fills) — that lives on the
        FinancialsCard.
      </p>
    </div>
  );
}
