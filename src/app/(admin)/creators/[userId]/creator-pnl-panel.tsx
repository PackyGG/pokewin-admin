import { Info, LineChart, TrendingDown, TrendingUp } from "lucide-react";

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

  // Lifetime / all-time hero. Same canonical formula as the per-
  // period tiles below, but evaluated as a snapshot — so balance /
  // inventory / vouchers are CURRENT values (not deltas), which is
  // what "all-time PnL" naturally reads as.
  const lifetimePnl = data.lifetime.pnl;
  const isLifetimeWin = lifetimePnl > 0;
  const isLifetimeLoss = lifetimePnl < 0;
  const lifetimeAccent: "emerald" | "rose" | "blue" = isLifetimeWin
    ? "emerald"
    : isLifetimeLoss
      ? "rose"
      : "blue";

  return (
    <div className="space-y-3">
      <SectionHeading icon={LineChart} title="Affiliates PnL" />

      {/* All-time hero — the single number admins most often want
          to scan ("how much have we made off this creator
          lifetime"). Spans full width, larger heading, breakdown
          rows below the hero number. Period tiles below stay for
          drill-in on shorter horizons.

          The icon flips with the result — TrendingUp when we won
          (emerald), TrendingDown when we lost (rose), LineChart on
          zero. Matches the per-period tiles below so win/loss is
          obvious at a glance even before reading the colour. */}
      <StatPanel
        title="All-time"
        icon={
          isLifetimeWin
            ? TrendingUp
            : isLifetimeLoss
              ? TrendingDown
              : LineChart
        }
        accent={lifetimeAccent}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <div
              className={cn(
                "text-3xl font-bold tabular-nums leading-none sm:text-4xl",
                isLifetimeWin
                  ? "text-emerald-600 dark:text-emerald-400"
                  : isLifetimeLoss
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
              )}
              title="Lifetime House P&L from this creator's affiliates"
            >
              {lifetimePnl === 0
                ? "—"
                : `${isLifetimeWin ? "+" : ""}${formatCurrency(lifetimePnl)}`}
            </div>
            <p className="text-xs text-muted-foreground">
              Lifetime House P&amp;L from this creator&apos;s affiliates
              <br />
              <span className="text-[10px]">
                Positive (emerald) = we won · Negative (rose) = we lost
              </span>
            </p>
          </div>
        </div>
        {/* Prominent disclaimer about what THIS number does NOT
            include — admins were misreading the result as "total
            creator profitability". Affiliates PnL is ONLY the
            referrals-side P&L; commission / tips / fills paid TO
            the creator live on the FinancialsCard. */}
        <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="size-3.5 shrink-0 mt-0.5" />
          <span>
            Affiliates only — excludes creator deal cost (commission,
            tips, fills, weekly fills). Combine with the
            FinancialsCard&apos;s deal cost to get net creator
            economics.
          </span>
        </div>
        {/* Snapshot components — currentBalance / currentInventory /
            currentVouchers are RIGHT-NOW values (liability), not
            window deltas. Same house-POV color rules: positive
            liability subtracts from PnL → rose; positive cash-in
            adds to PnL → emerald. */}
        <div className="mt-4 grid grid-cols-1 gap-y-0.5 sm:grid-cols-2 sm:gap-x-6">
          <PanelRow
            label="Total Deposits"
            value={
              data.lifetime.totalDeposits === 0
                ? "—"
                : formatCurrency(data.lifetime.totalDeposits)
            }
            valueClassName={
              data.lifetime.totalDeposits > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : ""
            }
          />
          <PanelRow
            label="Total Withdrawals"
            value={
              data.lifetime.totalWithdrawals === 0
                ? "—"
                : formatCurrency(data.lifetime.totalWithdrawals)
            }
            valueClassName={
              data.lifetime.totalWithdrawals > 0
                ? "text-rose-600 dark:text-rose-400"
                : ""
            }
          />
          <PanelRow
            label="Current Balance"
            value={
              data.lifetime.currentBalance === 0
                ? "—"
                : formatCurrency(data.lifetime.currentBalance)
            }
            valueClassName={
              data.lifetime.currentBalance > 0
                ? "text-rose-600 dark:text-rose-400"
                : ""
            }
          />
          <PanelRow
            label="Current Inventory"
            value={
              data.lifetime.currentInventory === 0
                ? "—"
                : formatCurrency(data.lifetime.currentInventory)
            }
            valueClassName={
              data.lifetime.currentInventory > 0
                ? "text-rose-600 dark:text-rose-400"
                : ""
            }
          />
          <PanelRow
            label="Current Vouchers"
            value={
              data.lifetime.currentVouchers === 0
                ? "—"
                : formatCurrency(data.lifetime.currentVouchers)
            }
            valueClassName={
              data.lifetime.currentVouchers > 0
                ? "text-rose-600 dark:text-rose-400"
                : ""
            }
          />
        </div>
      </StatPanel>

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
