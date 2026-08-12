import type { LeaderboardAdminRow } from "@/lib/backend-api/contracts";

export type ApprovedLeaderboardTerms = {
  creatorUserId: string;
  approvedBy: string;
  title: string;
  codes: string[];
  siteBonusUsd: number;
  startsAt: string;
  endsAt: string;
  prizeTiers: Array<{ position: number; prizeAmountUsd: number }>;
};

const cents = (value: number | string) => Math.round(Number(value) * 100);
const sorted = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
const canonicalTiers = (tiers: Array<{ position: number; prizeAmountUsd: number | string }>) =>
  tiers
    .map((tier) => ({ position: tier.position, cents: cents(tier.prizeAmountUsd) }))
    .sort((a, b) => a.position - b.position);

/** Recover an already-created board from its immutable commercial terms. */
export function matchingApprovedLeaderboards(
  rows: LeaderboardAdminRow[],
  terms: ApprovedLeaderboardTerms,
): LeaderboardAdminRow[] {
  const expectedCodes = JSON.stringify(sorted(terms.codes));
  const expectedTiers = JSON.stringify(canonicalTiers(terms.prizeTiers));
  const expectedStart = new Date(terms.startsAt).getTime();
  const expectedEnd = new Date(terms.endsAt).getTime();

  return rows.filter((row) =>
    row.creator_user_id === terms.creatorUserId
    && row.co_creator_user_ids.length === 0
    && row.approval_status === "approved"
    && row.cancelled_at === null
    && row.approved_by === terms.approvedBy
    && row.title === terms.title
    && JSON.stringify(sorted(row.affiliate_codes)) === expectedCodes
    && cents(row.creator_prize_usd) === 0
    && cents(row.site_bonus_usd) === cents(terms.siteBonusUsd)
    && new Date(row.start_date).getTime() === expectedStart
    && new Date(row.end_date).getTime() === expectedEnd
    && JSON.stringify(canonicalTiers(row.prize_tiers.map((tier) => ({
      position: tier.position,
      prizeAmountUsd: tier.prize_amount_usd,
    })))) === expectedTiers
  );
}
