/**
 * /insights/streamers — shared types for the query layer.
 *
 * Domain summary:
 *   - "Streamer" = User with role='creator'. The streamer-insights page
 *     never lists non-creators in the headline lists; the populations
 *     they CONTROL (their referred users) are the unit of analysis for
 *     abuse signals.
 *   - "House P&L per creator" uses the same coverage-attribution model
 *     as `creators-pnl.ts` — deposits from a creator's referred cohort
 *     net of card withdrawals + affiliate payouts to the creator.
 *
 * Money convention: every numeric in this layer follows the House-POV
 * rule from CLAUDE.md. Positive `housePnl` = we kept money. Negative =
 * users took money out.
 */

/** Per-creator aggregate row — drives Overview, Money Makers, ROI tabs. */
export type CreatorInsightRow = {
  userId: string;
  username: string | null;
  email: string | null;
  image: string | null;
  primaryCode: string | null;
  // ── Cohort ─────────────────────────────────────────────
  referredCount: number;
  activeReferredCount: number;
  ftdReferredCount: number;
  // ── House-side revenue (the cohort's contribution) ─────
  // Sum of `affiliate_code_usages.wager_amount_usd` in the
  // requested period, for users referred by THIS creator,
  // staff excluded.
  cohortWagerUsd: number;
  cohortDepositsUsd: number;
  cohortCardWithdrawalsUsd: number;
  // ── Outflows TO the creator ────────────────────────────
  // Two distinct cost buckets:
  //   • commissionPaidUsd — what the creator earned on this cohort's
  //     activity (referrer_cut_usd from affiliate_code_usages). Even
  //     if it never left the platform, it's a liability we owe them.
  //   • payoutSettledUsd — what was actually paid out of our account
  //     to the creator (affiliate_payouts.status='paid'). The two
  //     differ when commission sits unclaimed in their available_usd.
  commissionAccruedUsd: number;
  payoutSettledUsd: number;
  // ── Net to the house ───────────────────────────────────
  // housePnl = cohortDeposits − cohortCardWithdrawals − commissionAccrued
  // The minus-commission term is intentional: even unpaid commission is
  // money we owe the creator. Settled payouts are a subset, not
  // additional.
  housePnl: number;
  // ROI = housePnl / commissionAccrued. null when no commission accrued
  // in the period (avoids ∞ / NaN). Higher = better for the house.
  houseRoi: number | null;
};

/** Sus-signal scoring. Per CLAUDE.md guidance: 50+ amber, 75+ rose. */
export type SignalScore = {
  /** Numeric 0..100 contribution to the overall risk score. */
  score: number;
  /** Short label rendered in the tooltip / drawer. */
  label: string;
  /** Optional metric value shown beside the label. */
  detail?: string;
};

export type CreatorRiskRow = {
  userId: string;
  username: string | null;
  primaryCode: string | null;
  /** 0..100 — sum of signal scores capped at 100. */
  totalRiskScore: number;
  signals: SignalScore[];
  /** Quick-look counters used by the table cells. */
  referredCount: number;
  cohortWagerUsd: number;
};

/** Code-switching surface — users who used 2+ DISTINCT codes. */
export type CodeSwitcherRow = {
  userId: string;
  username: string | null;
  email: string | null;
  /** Codes used by this user, oldest → newest. */
  codeChronology: { code: string; firstUsedAt: string; ownerUsername: string | null }[];
  codeCount: number;
  totalWagerUsd: number;
  totalDepositsUsd: number;
  /** Race claims this user picked up under any of those codes — surfaces
   *  the "switched to win a race then switched back" pattern. */
  raceClaimCount: number;
  raceClaimUsd: number;
};

/** Leaderboard sniping — race winners whose code history is suspicious. */
export type LeaderboardSnipeRow = {
  userId: string;
  username: string | null;
  raceType: "daily" | "weekly" | "monthly";
  racePeriodStart: string;
  position: number;
  prizeUsd: number;
  /** Code in use at the time the race was claimed. NULL when no acu
   *  row exists in the 14d lookback before the claim. */
  codeAtClaim: string | null;
  /** Total DISTINCT codes the user has ever used. >=2 → switcher. */
  totalCodesUsed: number;
  /** Most recent code the user has used (post-claim). When this differs
   *  from codeAtClaim, the user switched away after winning. */
  mostRecentCode: string | null;
  switchedAway: boolean;
};
