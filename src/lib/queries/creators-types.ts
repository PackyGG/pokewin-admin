/**
 * Per-window House P&L for a single creator's referrals — same canonical
 * formula as the lifetime Platform-P&L on the dashboard / user-detail
 * page, evaluated as DELTAS over the window:
 *
 *   pnl = deposits − withdrawals − balanceChange − inventoryChange − voucherChange
 *
 * House POV:
 *   pnl > 0 (emerald) — house made money in the window
 *   pnl < 0 (rose)    — house lost money in the window
 *
 * "Withdrawals" combines on-balance cash withdrawals (ledger
 * `withdrawal` debits) and physical card withdrawals
 * (card_withdrawal_requests with status completed/shipped, time-scoped
 * by COALESCE(shipped_at, completed_at)). "BalanceChange",
 * "inventoryChange" and "voucherChange" are net deltas in user-side
 * liability over the window — positive means we owe MORE at the end of
 * the window than we did at the start, so they SUBTRACT from house P&L.
 */
export type CreatorPnlPeriod = {
  period: string;
  /** Real cash deposits in the window (lt.type='deposit'). */
  deposits: number;
  /**
   * Cash + cards leaving the house in the window:
   *   ledger withdrawals (lt.type='withdrawal', ABS) +
   *   card_withdrawal_requests.total_value_usd for status in
   *   ('completed','shipped') with COALESCE(shipped_at, completed_at)
   *   in window.
   */
  withdrawals: number;
  /**
   * Net change in on-site balance (available + locked) over the window.
   * Computed as SUM(ledger.amount) for completed transactions in the
   * window — the balance is the running sum of every ledger event, so
   * the windowed change is just the windowed sum.
   */
  balanceChange: number;
  /**
   * Net change in unsold-inventory liability over the window:
   *   value_at_obtained for items obtained_at IN window
   *   −
   *   value_at_obtained for items sold_at OR exchanged_at IN window
   * Positive = we owe MORE inventory at the end of the window.
   */
  inventoryChange: number;
  /**
   * Net change in unclaimed-voucher liability over the window:
   *   value of vouchers created_at IN window
   *   −
   *   value of vouchers claimed_at IN window
   * Positive = we owe MORE voucher value at the end of the window.
   */
  voucherChange: number;
  /**
   * House P&L for the window. Same canonical balance-sheet formula the
   * dashboard's lifetime PnL uses, evaluated per window.
   */
  pnl: number;
};

/**
 * All-time House P&L for a single creator's referrals. Same canonical
 * formula as `CreatorPnlPeriod.pnl`, but evaluated as a SNAPSHOT
 * (not a delta over a window):
 *
 *   lifetimePnl = totalDeposits − totalWithdrawals − currentBalance
 *               − currentInventory − currentVouchers
 *
 * This is the natural reading of "how much have we made off this
 * creator's affiliates lifetime?" — cumulative cash inflow minus
 * cumulative cash outflow minus what we currently owe.
 *
 * Same staff + blacklist exclusions as the windowed query.
 */
export type CreatorLifetimePnl = {
  /** Sum of every completed deposit from the referred-user pool. */
  totalDeposits: number;
  /**
   * Sum of every completed withdrawal — combines:
   *   • card_withdrawal_requests (status completed/shipped)
   *   • ledger admin_balance_adjustment rows tagged "Manual withdrawal:%"
   */
  totalWithdrawals: number;
  /**
   * Current on-site balance (available + locked) for the referred-user
   * pool — house liability snapshot.
   */
  currentBalance: number;
  /** Current unsold-inventory liability snapshot. */
  currentInventory: number;
  /** Current unclaimed-voucher liability snapshot. */
  currentVouchers: number;
  /** lifetime PnL — house POV: positive = house made money. */
  pnl: number;
};

export type CreatorPnlData = {
  byPeriod: CreatorPnlPeriod[];
  /**
   * All-time PnL for the creator's affiliates. Computed as a single
   * balance-sheet snapshot rather than a windowed delta so it
   * matches the dashboard's lifetime P&L semantics for the same
   * user pool. Surfaces as the hero tile on /creators/[userId].
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
