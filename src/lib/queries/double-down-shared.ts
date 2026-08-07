/**
 * Double Down — CLIENT-SAFE shared pieces (period constants/helpers + the
 * result/status/row TYPES). This module has NO server-only imports (no
 * server database modules, so client components — the period chip
 * strip, the badges, the log table — can import the period runtime values and
 * the row types WITHOUT dragging the server query graph into the browser
 * bundle (the exact build error that forced this split; same pattern as
 * `insights-analytics/period`).
 *
 * The server module `double-down.ts` re-exports everything here so server
 * call sites keep a single import path.
 */

// ── Periods (runtime values usable from client components) ────────────────────

export type DoubleDownPeriod = "24h" | "7d" | "30d" | "90d" | "all";

export function doubleDownPeriodLabel(p: DoubleDownPeriod): string {
  switch (p) {
    case "24h":
      return "Last 24 hours";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "all":
      return "Lifetime";
  }
}

/**
 * Lifetime lookback cap (days). The `all` window resolves to this finite
 * lower bound instead of an unbounded scan (CLAUDE.md "Performance &
 * Daten-Laden" forbids unbounded lifetime scans). 365d mirrors
 * INSIGHTS_LIFETIME_LOOKBACK_DAYS used by the reward sweeps and covers all
 * currently-relevant Double Down activity (the feature is new).
 */
const DOUBLE_DOWN_LIFETIME_LOOKBACK_DAYS = 365;

/** Day count for a window; `all` resolves to the capped lifetime lookback. */
export function daysForDoubleDownPeriodCapped(p: DoubleDownPeriod): number {
  switch (p) {
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return DOUBLE_DOWN_LIFETIME_LOOKBACK_DAYS;
  }
}

/** Cache TTL — short windows move fast, lifetime barely moves. */
export function cacheTtlForDoubleDownPeriod(p: DoubleDownPeriod): number {
  return p === "all" ? 300 : 60;
}

// ── Shapes (types — erased at compile time, safe anywhere) ────────────────────

export type DoubleDownResult = "win" | "lose";

export type DoubleDownStats = {
  /**
   * STARTED rounds in the window — rounds the user actually played
   * (status IN accepted/resolved). Double Down is OPTIONAL, so offered/expired
   * (never-taken) offers are NOT counted anywhere (owner rule, 2026-06-30).
   */
  totalRounds: number;
  /** Resolved rounds (result is set). */
  resolvedRounds: number;
  winCount: number;
  loseCount: number;
  /**
   * wins / resolved (0..1), null when nothing resolved yet. The house margin
   * lives ENTIRELY in the win odds (~45% player / 55% site) — there is no
   * per-round cut (owner clarification, 2026-06-30). Noisy at low volume.
   */
  winRate: number | null;
  /** Σ won_amount_usd over RESOLVED rounds — the total wager (winnings staked). */
  totalStaked: number;
  /**
   * Σ the paired payout voucher's REAL value over WINS (house COST → rose).
   * The actual credited amount (reconciles to the voucher_redeemed ledger) —
   * NO multiplier, NO metadata fallback.
   */
  totalPaidOut: number;
  /**
   * House P&L over RESOLVED rounds = totalStaked − totalPaidOut. Losers forfeit
   * their full stake (house keeps it); winners get their stake back. >0 = house
   * PROFIT (emerald), <0 = house loss (rose).
   */
  netHousePnl: number;
  /**
   * Distinct battles (customer-scoped) in the window that had at least one
   * STARTED Double Down round — the NUMERATOR of "how many battles do double
   * down". Distinct battle_id, so a battle with two DD rounds counts once.
   */
  distinctBattlesWithDd: number;
  /**
   * Total battles in the SAME window (all battles, index-served on
   * battles(created_at)) — the DENOMINATOR. Not customer-scoped (a battle has
   * no single owner) — this is the whole battle population the window covers.
   */
  totalBattles: number;
  /**
   * distinctBattlesWithDd / totalBattles (0..1), null when totalBattles is 0
   * (divide-by-zero guard). Neutral engagement %, not a P&L number.
   */
  battleDoubleDownRate: number | null;
};

export type DoubleDownLogRow = {
  id: string;
  userId: string;
  username: string | null;
  battleId: string;
  /** The staked battle winnings (won_amount_usd). */
  stakedUsd: number;
  result: DoubleDownResult | null;
  /** Actual payout voucher value to the user on a win (rose). Null otherwise. */
  payoutUsd: number | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type DoubleDownLog = {
  rows: DoubleDownLogRow[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

/**
 * One time-bucket of Double Down activity for the /insights charts. The page is
 * locked to a 30d window, so buckets are DAILY (one bar per day; hourly crammed
 * up to 720 bars under 24 repeating "HH:00" labels). Serializable row (no
 * function props across RSC).
 *   • bucket  — "yyyy-MM-dd" UTC day key for the X axis (the client chart
 *               pretty-prints it to "MMM d").
 *   • started — count of STARTED rounds in the day (Usage chart).
 *   • pnl     — net house P&L for the day over RESOLVED rounds = staked −
 *               real voucher payout (House-POV: >0 profit emerald, <0 rose).
 *   • cumPnl  — running cumulative house P&L through this bucket (rendered as
 *               the cumulative House-P&L line on the P&L chart).
 */
export type DoubleDownTimeSeriesPoint = {
  bucket: string;
  started: number;
  pnl: number;
  cumPnl: number;
};

/**
 * Dashboard lifetime stats for Double Down — counted the DEV's CANONICAL way:
 * `game_sessions WHERE game_type='battle_double_down'` JOINed on game_id →
 * battle_double_down_offers. A game_session row exists ONLY for a round that
 * was actually PLAYED (accepted → resolved), so this counts PLAYED rounds —
 * exactly how the dashboard counts pack / battle / upgrader game-plays — NOT
 * the offered/expired rounds the Insights audit log also surfaces.
 */
export type DoubleDownDashboardStats = {
  /** Played rounds (game_sessions of this game_type). */
  rounds: number;
  wins: number;
  loses: number;
  /** Unresolved plays (normally 0 — a session implies a resolved round). */
  pending: number;
  uniquePlayers: number;
  /**
   * wins / (wins+loses), null when nothing resolved. The house margin is in
   * the win odds (~45% player / 55% site), not a per-round cut.
   */
  winRate: number | null;
  /** Σ won_amount_usd over RESOLVED plays — the total wager (winnings staked). */
  staked: number;
  /**
   * Σ the paired payout voucher's REAL value over WINS — paid to winners
   * (house COST → rose). Actual credited amount; NO multiplier/fallback.
   */
  paidOut: number;
  /**
   * House P&L over RESOLVED rounds = staked − paidOut. Losers forfeit their
   * full stake (house keeps it); winners get their stake back. >0 = house
   * PROFIT (emerald).
   */
  netHousePnl: number;
};

type UserDoubleDownHistory = {
  /** Per-user summary over ALL of this user's rounds. */
  summary: {
    totalRounds: number;
    resolvedRounds: number;
    winCount: number;
    loseCount: number;
    winRate: number | null;
    totalStaked: number;
    totalPaidOut: number;
    /** netStakedVsPaid = totalStaked − totalPaidOut (house-kept on this user). */
    netStakedVsPaid: number;
    /**
     * Net house P&L on THIS user — the headline "did WE make money on them":
     * forfeited (their loses) − payouts (their wins). Real money flows ONLY,
     * NO edge term (same definition as the Insights / dashboard House P&L
     * tile). Positive = house profit on this user (emerald), negative = loss
     * (rose).
     */
    netHousePnl: number;
  };
  /** Recent rounds, newest first. */
  rows: DoubleDownLogRow[];
};
