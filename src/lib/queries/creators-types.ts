/**
 * Per-window House P&L for a single creator's referrals — cash that
 * came IN under this creator's code minus the value of physical
 * cards that left the house from sessions wagered under that code.
 *
 *   pnl = deposits − cardWithdrawals
 *
 * Wagered volume is reported alongside the formula as an
 * informational metric (it doesn't appear in the formula — wagers
 * spin back and forth within the platform, only deposits and
 * physical card withdrawals move value across the platform boundary).
 *
 * KEY DIFFERENCE vs. the previous balance-sheet formula: attribution
 * is event-level, sourced from `affiliate_code_usages`. Each row
 * carries the code that was active when the event happened.
 *   • `usage_type = 'deposit'`: carries `deposit_amount_usd` booked
 *     against the code active at the time of deposit.
 *   • `usage_type = 'wager'`: carries `wager_amount_usd` AND
 *     `game_session_id` — the latter is used to attribute physical
 *     card withdrawals back to this creator (the card must have been
 *     obtained in a session that wagered under this code).
 *
 * A referred user who later switches codes stops contributing from
 * that point on, and never gets attributed to multiple creators for
 * the same event.
 *
 * Referred-user pool excludes admin / support / creator roles, the
 * creator's own user_id, and the motha-managed blacklist.
 *
 * House POV: positive (emerald) = we kept value, negative (rose) =
 * physical cards out exceeded cash deposited.
 */
/**
 * Per-user breakdown of a period's contribution. Surfaced via the
 * hover popover on each period tile so admins can see which referred
 * users actually drove the number. One row per user with non-zero
 * activity in the period; `pnl = deposits − cardWithdrawals` follows
 * the same formula as the panel headline.
 */
export type CreatorPnlPeriodUser = {
  userId: string;
  username: string | null;
  image: string | null;
  deposits: number;
  wagered: number;
  cardWithdrawals: number;
  pnl: number;
  /**
   * Whether this user has at least one `affiliate_code_usages` row of
   * `usage_type = 'deposit'` under this creator — i.e. they actually
   * deposited cash while on this creator's code, not just wagered
   * later after switching codes.
   *
   * Non-depositors are surfaced in the popover for context (with a
   * warning badge) but their card withdrawals are EXCLUDED from the
   * panel's PnL calculation — the house didn't realise creator-A
   * attribution from a user whose deposits flowed to a different
   * code. Keeping their cardWD in the formula was over-penalising
   * the creator for value-out events tied to deposits the creator
   * was never credited with.
   */
  isDepositor: boolean;
};

export type CreatorPnlPeriod = {
  period: string;
  /**
   * Sum of `affiliate_code_usages.deposit_amount_usd` for `usage_type =
   * 'deposit'` rows where `affiliate_user_id = creator` and the acu row
   * was created in the window. One row per deposit carrying the amount
   * booked against the code that was active at the time.
   */
  deposits: number;
  /**
   * Sum of `affiliate_code_usages.wager_amount_usd` for `usage_type =
   * 'wager'` rows in the window. Informational — does NOT feed the
   * PnL formula (wagers spin in-platform; only deposits cross the
   * money-in boundary).
   */
  wagered: number;
  /**
   * Value of cards that physically left the house in the window
   * (`card_withdrawal_requests` with status completed/shipped, time
   * scoped by `COALESCE(shipped_at, completed_at)`), where the card
   * was originally obtained in a session wagered under this creator's
   * code. Uses `card_withdrawal_requests.inventory_item_ids` →
   * `user_inventory.source_id` (set to `game_session_id` when
   * `source_type IN ('pack','battle')`) → the creator's acu session
   * set. Per-card valuation uses `user_inventory.value_at_obtained`
   * so a withdrawal mixing cards from multiple codes is split
   * correctly.
   */
  cardWithdrawals: number;
  /** PnL for the window — `deposits − cardWithdrawals`. */
  pnl: number;
  /**
   * Per-user contribution to this period. Sorted by `abs(pnl)` desc
   * with deposit volume as tiebreaker — biggest movements surface
   * first. Capped at 50 rows; the period totals on the parent
   * `CreatorPnlPeriod` are computed from ALL activity, so this list
   * being truncated never invalidates the headline number.
   */
  users: CreatorPnlPeriodUser[];
};

/**
 * All-time House P&L for a single creator's referrals. Same formula
 * as `CreatorPnlPeriod`, evaluated over the entire history.
 *
 *   lifetimePnl = totalDeposits − totalCardWithdrawals
 */
export type CreatorLifetimePnl = {
  /**
   * Lifetime sum of `acu.deposit_amount_usd` for `usage_type =
   * 'deposit'` rows under this creator. Attributed at the time of
   * the deposit to the code that was active then.
   */
  totalDeposits: number;
  /**
   * Lifetime sum of `acu.wager_amount_usd` for `usage_type = 'wager'`
   * rows under this creator. Informational only — does NOT feed
   * `pnl`.
   */
  totalWagered: number;
  /**
   * Lifetime value of physical card withdrawals attributed to this
   * creator's sessions (same join chain as
   * `CreatorPnlPeriod.cardWithdrawals`, no window cap).
   */
  totalCardWithdrawals: number;
  /** P&L lifetime — `totalDeposits − totalCardWithdrawals`. */
  pnl: number;
};

export type CreatorPnlData = {
  byPeriod: CreatorPnlPeriod[];
  /**
   * All-time P&L for the creator's affiliates. Surfaces as the hero
   * tile on /creators/[userId].
   */
  lifetime: CreatorLifetimePnl;
};

export type CreatorLimits = {
  currencyLimitAmount: number | null;
  percentageLimit: number | null;
  tipLimit: number | null;
  currencyLimitResetDays: number | null;
};

export type CreatorListItem = {
  userId: string;
  username: string | null;
  code: string;
  // Every code this creator owns, oldest-first. The `code` field
  // above is the primary (oldest); this array carries the full set
  // plus their ids so the inline codes editor can remove specific
  // rows.
  codes: { id: string; code: string }[];
  // True when this creator has at least one creator_deals row with
  // status='active' AND no future end_date. Drives the "Active"
  // indicator in the Username cell + the primary sort key in the
  // /creators list query.
  hasActiveDeal: boolean;
  level: number;
  totalReferred: number;
  totalSignups: number;
  totalEarnedUsd: number;
  availableUsd: number;
  totalPaidOutUsd: number;
  // 3-day rolling deposit + wager volume from this creator's
  // affiliate referrals (staff-excluded). Surfaces "active right
  // now" momentum on the row alongside the all-time totals.
  deposits3dUsd: number;
  wagers3dUsd: number;
  limits: CreatorLimits;
};

export type UserSearchResult = {
  userId: string;
  username: string | null;
  email: string | null;
  role: string;
};

export type CodeListItem = {
  code: string;
  ownerUserId: string;
  ownerUsername: string | null;
  isActive: boolean;
  createdAt: string;
};

export type AffiliateAnalyticsData = {
  totalSignups: number;
  totalCommissionPaid: number;
  totalWagerVolume: number;
  totalDepositVolume: number;
  totalClicks: number;
  activeCreators: number;
  daily: {
    date: string;
    signups: number;
    commission: number;
    wagerVolume: number;
    depositVolume: number;
    clicks: number;
  }[];
};

export type CreatorTipItem = {
  id: string;
  rainId: string;
  amountUsd: number;
  rainTotalPool: number;
  rainStatus: string;
  rainWinnerUsername: string | null;
  createdAt: string;
};
