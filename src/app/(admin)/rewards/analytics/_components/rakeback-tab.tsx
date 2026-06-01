import { Percent } from "lucide-react";
import { getRakebackAnalytics } from "@/lib/queries/rewards-category-analytics";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";
import {
  CategoryDeepStatsPanel,
  baseDeepStatsTiles,
} from "./category-deep-stats";

/**
 * Rakeback tab on /rewards/analytics. Renders the shared
 * CategoryDeepStatsPanel sourced from `rakeback_claim` ledger rows
 * via the generic per-category helper.
 *
 * Category-specific extras intentionally NOT shown:
 *   - Rake-rate cohort spread — would need joining the user's claim
 *     metadata (which may or may not carry the rate) against a
 *     historical wager-volume cohort. Heavy + tag-dependent.
 *     PROPOSED (skipped this pass).
 *   - Average wager per claimant — same: implies pairing claims to
 *     the wager window the user's rakeback covers, which means
 *     joining ledger_transactions(wager types) per claim window.
 *     Heavy sweep over the wager table per recipient. PROPOSED.
 *
 * The baseline strip already surfaces unique recipients (== active
 * rakeback subscribers in the window), so that explicitly-requested
 * stat lands on the page without an extra query.
 *
 * House-POV: rakeback is money the house GIVES users → rose.
 */
export async function RakebackTab({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const data = await getRakebackAnalytics(period);
  const tiles = baseDeepStatsTiles(data, periodLabel, {
    countSub: "Rakeback claims",
  });
  return (
    <CategoryDeepStatsPanel
      data={data}
      periodLabel={periodLabel}
      headerIcon={Percent}
      headerTitle="Rakeback"
      tiles={tiles}
      unitLabel="claims"
      emptyTitle="No rakeback claims in this window"
      emptyDescription={`No rakeback was claimed in the ${periodLabel.toLowerCase()} period. Try a longer period.`}
    />
  );
}
