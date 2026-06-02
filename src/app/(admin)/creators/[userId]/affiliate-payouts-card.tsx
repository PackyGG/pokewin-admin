import { HandCoins, Info } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Affiliate-account payout state for this creator — the commission
 * lifecycle figures migrated out of the old plain-`<Card>` FinancialsCard
 * into the modern cost band, where they belong (all are house outflows /
 * obligations to the creator):
 *
 *   • Earned     — lifetime referral commission accrued to the creator.
 *   • Available  — commission accrued but not yet paid out (an open
 *                  house obligation).
 *   • Paid out   — commission already disbursed.
 *   • Bonus      — promo bonus the house distributed to the cohort
 *                  through this creator's account.
 *
 * House POV: every figure is money the house owes / has paid the creator
 * (or gifted the cohort) → 🔴 rose.
 *
 * NOTE on the relationship to the Creator Cost breakdown above: the cost
 * breakdown's "Referral commission" line is `total_paid_out_usd` — the
 * SAME source as "Paid out" here. This panel surrounds it with the rest
 * of the account state (earned / available / bonus) so the operator sees
 * the full commission picture, without double-counting (the headline net
 * uses the cost-breakdown commission, not these display rows).
 */
export function AffiliatePayoutsCard({
  earnedUsd,
  availableUsd,
  paidOutUsd,
  bonusDistributedUsd,
}: {
  earnedUsd: number;
  availableUsd: number;
  paidOutUsd: number;
  bonusDistributedUsd: number;
}) {
  const rose = "text-rose-600 dark:text-rose-400";
  const anySpend =
    earnedUsd > 0 || paidOutUsd > 0 || bonusDistributedUsd > 0;

  return (
    <StatPanel
      title="Affiliate payouts · lifetime"
      icon={HandCoins}
      accent={anySpend ? "rose" : "blue"}
    >
      <div className="space-y-1">
        <div
          className={`text-2xl font-bold tabular-nums leading-none sm:text-3xl ${
            paidOutUsd > 0 ? rose : "text-muted-foreground"
          }`}
          title="Commission already disbursed to this creator (lifetime)"
        >
          {paidOutUsd === 0 ? "—" : formatCurrency(paidOutUsd)}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Commission paid out — the figure folded into the net&apos;s
          commission line
        </p>
      </div>
      <div className="mt-3 space-y-0.5">
        <PanelRow
          label="Earned (lifetime)"
          value={earnedUsd === 0 ? "—" : formatCurrency(earnedUsd)}
          valueClassName={earnedUsd > 0 ? rose : undefined}
        />
        <PanelRow
          label="Available (unpaid)"
          value={availableUsd === 0 ? "—" : formatCurrency(availableUsd)}
          valueClassName={availableUsd > 0 ? rose : undefined}
        />
        <PanelRow
          label="Bonus distributed"
          value={
            bonusDistributedUsd === 0
              ? "—"
              : formatCurrency(bonusDistributedUsd)
          }
          valueClassName={bonusDistributedUsd > 0 ? rose : undefined}
        />
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
        <Info className="size-3 shrink-0 mt-0.5" />
        <span>
          Commission accrued / paid to the creator. &quot;Paid out&quot; is
          the same source as the Net&apos;s separate commission line — shown
          here for the full account picture, not re-added to the net.
        </span>
      </div>
    </StatPanel>
  );
}
