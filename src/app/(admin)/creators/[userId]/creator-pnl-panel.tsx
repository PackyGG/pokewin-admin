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
 * mini-tiles (1d / 3d / 7d / 2w / 1m), each headlined with the GGR
 * from this creator's referrals in the window. Wager + payout sub-
 * rows show the inputs.
 *
 * GGR = ABS(wagers) − ABS(payouts) of every ledger transaction from
 * users this creator referred (joined via affiliate_code_usages →
 * DISTINCT referred_user_id), staff-excluded. Same wager + payout
 * type sets as the dashboard's global GGR (`_wager-payout-types.ts`),
 * so the per-creator number you see here reconciles 1:1 against the
 * dashboard for the same window.
 *
 * House POV: positive (emerald) means we made money on this creator's
 * affiliates in the window; negative (rose) means we lost money.
 *
 * Note: this is GGR only — it does NOT subtract creator-side deal
 * cost (commission, tips, manual fills paid TO the creator). Those
 * are an admin-side investment decision and live separately on the
 * FinancialsCard. Net-of-creator-cost would be GGR − creatorCost,
 * which the all-time row of getCreatorPnl already exposes.
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
          // GGR = ABS(wagers) − ABS(payouts) summed in the SQL. We
          // display this directly as the headline PnL — it's the
          // same number the dashboard's gaming-margin tile shows for
          // the same period, just scoped to this creator's referrals.
          const ggr = row?.ggr ?? 0;
          // Reverse out the original wagers / payouts the SQL summed
          // for the breakdown rows. costs is the user-credit subset
          // tracked via balance-delta, so wagers ≈ ggr + costs and
          // payouts ≈ costs (the COST_TYPES set is the dominant
          // credit slice). Not exact for non-COST payouts (card_sale,
          // battle_refund, card_exchange) — those flow through ggr
          // but aren't broken out individually in the panel. Good
          // enough for the breakdown signal, the headline ggr is
          // exact.
          const costs = row?.costs ?? 0;
          const wagersApprox = ggr + costs;
          const isWin = ggr > 0;
          const isLoss = ggr < 0;
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
                  title={`GGR — ${sub}`}
                >
                  {ggr === 0 ? "—" : formatCurrency(ggr)}
                </div>
                <p className="text-[10px] text-muted-foreground">{sub}</p>
              </div>
              <div className="mt-3 space-y-0.5">
                <PanelRow
                  label="Wagers"
                  value={formatCurrency(wagersApprox)}
                  valueClassName="text-emerald-600 dark:text-emerald-400"
                />
                <PanelRow
                  label="Payouts"
                  value={formatCurrency(costs)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
              </div>
            </StatPanel>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        PnL = referral wagers − referral payouts (GGR), house POV.
        Positive means we made money on this creator&apos;s affiliates
        in the window. Excludes creator-side deal cost (commission,
        tips, fills) — that lives on the FinancialsCard.
      </p>
    </div>
  );
}
