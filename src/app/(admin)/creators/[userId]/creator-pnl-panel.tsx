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
 * Per-creator affiliate PnL panel for /creators/[userId]. Renders 5
 * mini-tiles (1d / 3d / 7d / 2w / 1m), each headlined with the
 * comprehensive house P&L from this creator's referrals in the window.
 *
 * P&L = GGR − inventoryChange
 *     = (wagers − realized_payouts) − (inventory_obtained − inventory_disposed)
 *
 * The inventoryChange term is what fixes the "user pulled a $500 card
 * and didn't sell it" undercount: gross GGR alone would call that a
 * win, but we still owe the user $500 in inventory liability, so the
 * true house P&L is negative. Same comprehensive shape as Platform
 * P&L on /users/[id] (Deposits − Withdrawals − Balance − Inventory −
 * Vouchers), evaluated per window.
 *
 * House POV: positive (emerald) = we made money on this creator's
 * affiliates in the window; negative (rose) = we lost money.
 *
 * Note: this is referral-side P&L only — it does NOT subtract
 * creator-side deal cost (commission, tips, manual fills paid TO the
 * creator). Those are an admin-side investment decision and live on
 * the FinancialsCard. Net-of-creator-cost is exposed as
 * `truePlatformPnl` on the all-time data record.
 */
export async function CreatorPnlPanel({ userId }: { userId: string }) {
  const data = await getCreatorPnl(userId);

  // Map period key → row for O(1) lookup. The query returns 7 buckets
  // (3h / 12h / 24h / 3d / 7d / 14d / 30d) but the panel only renders
  // the 5 that match the user's spec.
  const byPeriod = new Map(data.byPeriod.map((p) => [p.period, p]));

  return (
    <div className="space-y-3">
      <SectionHeading icon={LineChart} title="Affiliates PnL" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {DISPLAYED_PERIODS.map(({ key, label, sub }) => {
          const row = byPeriod.get(key);
          // Display the comprehensive house P&L (GGR minus the
          // unrealized inventory the user gained). This matches the
          // Platform-P&L formula on /users/[id] so a creator whose
          // referrals pulled a fat card without selling it shows up
          // as the loss it actually is.
          const ggr = row?.ggr ?? 0;
          const inventoryChange = row?.inventoryChange ?? 0;
          const netPnl = ggr - inventoryChange;
          const isWin = netPnl > 0;
          const isLoss = netPnl < 0;
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
                  {netPnl === 0 ? "—" : formatCurrency(netPnl)}
                </div>
                <p className="text-[10px] text-muted-foreground">{sub}</p>
              </div>
              <div className="mt-3 space-y-0.5">
                {/* GGR row — realized gaming margin (wagers minus
                    realized payouts). Headline P&L subtracts the
                    unrealized inventory the user accumulated on top
                    of this. */}
                <PanelRow
                  label="GGR"
                  value={formatCurrency(ggr)}
                  valueClassName={
                    ggr > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : ggr < 0
                        ? "text-rose-600 dark:text-rose-400"
                        : ""
                  }
                />
                {/* Inventory change — how much value the user banked
                    in their inventory (cards from packs they
                    haven't sold yet). Subtracted from GGR to get
                    house P&L. */}
                <PanelRow
                  label="Inventory"
                  value={
                    inventoryChange === 0
                      ? "—"
                      : `+${formatCurrency(inventoryChange)}`
                  }
                  valueClassName={
                    inventoryChange > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : inventoryChange < 0
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
        House P&amp;L = referral GGR (wagers − realized payouts) minus
        unrealized inventory the user gained (cards still held). Same
        shape as Platform P&amp;L on /users/[id]. Positive (emerald) =
        we made money. Excludes creator-side deal cost (commission,
        tips, fills) — that lives on the FinancialsCard.
      </p>
    </div>
  );
}
