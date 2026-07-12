/**
 * Queries for the /creators/ads feature. Ad codes are plain
 * `affiliate_codes` rows owned by a single "house" user that the admin
 * designates via the admin_settings table. Everything else — clicks,
 * signups, depositor usages — already flows through the existing
 * affiliate infrastructure.
 *
 * Signup tracking source-of-truth: `affiliate_code_usages` rows where
 * `usage_type = 'signup'`. This is the canonical, transactional record
 * the backend writes alongside `user.referred_by`. We previously read
 * signups off `user.referred_by + user.affiliate_code`, which silently
 * undercounted whenever the recordSignupUsage hook had failed (we found
 * ~28 such cases historically). Reading from `affiliate_code_usages`
 * keeps this page aligned with /creators/codes/[code] and the wider
 * affiliate dashboard.
 *
 * Code casing: affiliate_clicks is always uppercase (trackClick
 * normalises). affiliate_codes/usages store mixed casing for legacy
 * rows. Every query here therefore matches case-insensitively
 * (UPPER/LOWER on both sides) so a code that landed lowercase in one
 * table still aligns with its uppercase sibling in another.
 */

export type AdCodeSummary = {
  code: string;
  createdAt: string;
  clicks: number;
  signups: number;
  /** Signed-up users on this code who later deposited or wagered. */
  activeReferrals: number;
  /** Unique users who made any deposit attributed to this code (from ledger). */
  depositors: number;
  /** Total number of deposit events booked to this code (from ledger). */
  depositEventCount: number;
  /** Real deposit volume on this code, summed from ledger.deposit_bonus events. */
  depositVolumeUsd: number;
  /** First-time deposit volume only (from affiliate_code_usages, FTD-gated by backend). */
  ftdVolumeUsd: number;
  wagerVolumeUsd: number;
  /** signups / clicks (0-1). 0 when no clicks yet. */
  conversionRate: number;
};

export type AdAggregate = {
  totalCodes: number;
  totalClicks: number;
  totalSignups: number;
  totalActiveReferrals: number;
  totalDepositors: number;
  totalDepositEventCount: number;
  totalDepositVolumeUsd: number;
  totalFtdVolumeUsd: number;
  totalWagerVolumeUsd: number;
};

export type AdCodeClicksByDay = { date: string; clicks: number };
export type AdCodeClicksByCountry = { country: string; clicks: number };

export type AdCodeSignup = {
  userId: string;
  username: string | null;
  email: string | null;
  createdAt: string;
  totalDepositedUsd: number;
  /**
   * balances.total_wagered for this user — surfaces how much each
   * referred user has bet, so admins can answer "where did the
   * code's wager volume come from?" by reading the signups table.
   */
  totalWageredUsd: number;
  isFtd: boolean;
};

/**
 * One row per user who has ever interacted with the code in any way
 * (signup, deposit, wager, etc.), aggregated across every
 * `affiliate_code_usages` row for that (code, user) pair. Surfaces
 * the per-row attribution (what the BACKEND credits to this code)
 * alongside the user's lifetime numbers (so admins can spot
 * mismatches and see who's actually moving the wager volume).
 */
export type AdCodeUsageEntry = {
  userId: string;
  username: string | null;
  email: string | null;
  /** Number of affiliate_code_usages rows for this (code, user). */
  usageCount: number;
  /** Distinct usage_type values observed on this (code, user). */
  usageTypes: string[];
  /** SUM(acu.wager_amount_usd) — wager attributed by the backend. */
  attributedWagerUsd: number;
  /** SUM(acu.deposit_amount_usd) — deposit attributed by the backend. */
  attributedDepositUsd: number;
  /** balances.total_wagered for the user — lifetime, all sources. */
  lifetimeWageredUsd: number;
  /** balances.total_won for the user — what the platform paid them
   *  back in winnings (lifetime). House paid this out → rose. */
  lifetimeWonUsd: number;
  /** balances.total_deposited for the user — lifetime, all sources. */
  lifetimeDepositedUsd: number;
  firstUsedAt: string;
  lastUsedAt: string;
};

export type AdCodeDetail = {
  code: string;
  createdAt: string;
  summary: AdCodeSummary;
  clicksByDay: AdCodeClicksByDay[];
  clicksByCountry: AdCodeClicksByCountry[];
  signupsList: AdCodeSignup[];
  /**
   * Every user who has ever used this code, in any usage_type,
   * sorted by attributed wager DESC. Answers "where is the code's
   * wager volume coming from?" — a row with $250 attributed wager
   * shows up at the top with the user's id, name, and lifetime
   * numbers for context.
   */
  usageHistory: AdCodeUsageEntry[];
};

