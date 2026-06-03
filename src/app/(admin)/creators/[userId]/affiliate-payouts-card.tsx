import { HandCoins, Info } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { InfoHint } from "../_components/info-hint";

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
 * HEADLINE = Earned (lifetime). The card leads with the lifetime referral
 * commission ACCRUED to this creator (`totalEarnedUsd`) — the house's full
 * commission cost / liability for their referrals (= paid out + still
 * unpaid). "Paid out" alone is a poor headline: on a creator who hasn't
 * withdrawn yet it's $0 even though real commission was earned, so the
 * meaningful number would be buried. Earned ⊇ {paid out, available}, so it
 * leads; the three (available / paid out / bonus) stay as breakdown rows.
 *
 * RELATIONSHIP TO THE CREATOR NET PANEL: the Creator Net (P&L) panel on
 * this page EXCLUDES affiliate commission entirely — its house-cost
 * breakdown is leaderboard / fill / tips / multiplier only, and its
 * footnote points the commission here ("Excludes affiliate commission —
 * that's on the Financials card"). So this card is the sole home of the
 * commission figure; nothing here is double-counted into the net.
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
      action={
        <InfoHint
          text="This creator's referral-commission account (lifetime): earned (the full house cost for their referrals), still-unpaid (available), already paid out, and promo bonus distributed to their cohort. The Creator Net panel excludes affiliate commission — it's accounted here, on this Financials card."
          side="left"
        />
      }
    >
      <div className="space-y-1">
        <div
          className={`text-2xl font-bold tabular-nums leading-none sm:text-3xl ${
            earnedUsd > 0 ? rose : "text-muted-foreground"
          }`}
          title="Lifetime referral commission accrued to this creator — the house's full commission cost/liability for their referrals (paid out + still-unpaid)."
        >
          {earnedUsd === 0 ? "—" : formatCurrency(earnedUsd)}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Commission earned (lifetime) — the house&apos;s full commission
          cost for this creator&apos;s referrals
        </p>
      </div>
      {/* Breakdown of the Earned headline: Available (still unpaid) +
          Paid out = Earned. Bonus distributed is a separate house outflow
          (promo bonus to the cohort), shown beneath. */}
      <div className="mt-3 space-y-0.5">
        <PanelRow
          label="Available (unpaid)"
          value={availableUsd === 0 ? "—" : formatCurrency(availableUsd)}
          valueClassName={availableUsd > 0 ? rose : undefined}
        />
        <PanelRow
          label="Paid out"
          value={paidOutUsd === 0 ? "—" : formatCurrency(paidOutUsd)}
          valueClassName={paidOutUsd > 0 ? rose : undefined}
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
          Commission accrued / paid to the creator. The headline is the
          lifetime earned commission — the house&apos;s full cost for this
          creator&apos;s referrals (= paid out + still-unpaid). The Creator
          Net panel excludes affiliate commission, so it&apos;s accounted
          here on this Financials card, not in the net.
        </span>
      </div>
    </StatPanel>
  );
}
