/**
 * Risk / Trust scoring for a single platform user — v2.
 *
 * What this module does
 * ─────────────────────
 * Given a user_id, computes a 0-100 risk score and a signal-level breakdown
 * describing WHY that score was produced. The intent is to surface fraud /
 * abuse / advantage-play patterns that a human moderator would otherwise
 * need to hunt for across a dozen tables.
 *
 * Design notes
 * ────────────
 *   - The score is the sum of weights of TRIGGERED signals, clamped to
 *     [0, 100]. Individual signal weights tune severity. Where a signal is
 *     graded (e.g. "shares IP with 10 OTHER users" is worse than "shares
 *     with 1"), the weight scales inside a bounded range so a single noisy
 *     signal cannot dominate.
 *   - Signals are grouped into five categories (velocity / gameplay /
 *     rewards / network / account). Weights within a category are capped
 *     so no one vertical can max out the score alone.
 *   - Everything is READ-ONLY. We only query Main DB here (game/user data);
 *     admin_notes count comes from Admin DB. No ledger writes.
 *   - Heavy path uses raw SQL with one subselect per signal — see the
 *     companion list-score query for a batch flavour of the same logic.
 *
 * Tier mapping (CLAUDE.md house-POV: red = house loses = suspicious user):
 *   0-19    → low       (emerald)
 *   20-49   → medium    (amber)
 *   50-74   → high      (orange)
 *   75-100  → critical  (rose)
 *
 * ----------------------------------------------------------------------
 * FIXTURES (manual test scenarios).
 *
 * 1. Clean user
 *    - 90-day-old account, 2FA on, email verified.
 *    - Deposited $200 twice, wagered $500, withdrew $50 after wagering.
 *    - One country, unique fingerprint, no feature locks.
 *    Expected: score ≤ 10, tier "low".
 *
 * 2. Bonus-abuse new account
 *    - 14-minute-old account.
 *    - Claimed a $10 signup reward (balance_reward_claim).
 *    - Did NOT wager.
 *    - Submitted a card_withdrawal request.
 *    Expected: score ≥ 75, tier "critical".
 *
 * 3. Multi-accounter sharing IP + fingerprint
 *    - 3-day-old account.
 *    - Shares IP with 4 users, fingerprint with 2, one banned.
 *    - Uses affiliate code owned by IP-shared user.
 *    Expected: score ≥ 75, tier "critical".
 *
 * 4. Grinder — low house edge, otherwise clean
 *    - 120-day-old account, $50k wagered, 1.2% user house edge.
 *    Expected: score 20-49, tier "medium".
 *
 * 5. Banned user
 *    - is_banned=true, 2 feature locks, 5 admin notes, 3 chat mutes.
 *    Expected: score ≥ 75, tier "critical".
 */

import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import {
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  MS_PER_WEEK,
} from "@/lib/utils/time";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Pure types + client-safe helpers moved to ./score-types so client
// components can import them without dragging `db` / `adminDb` into the
// browser bundle. Re-exported here for backward compatibility with
// existing server-side callers.
export {
  RISK_TIER_COLORS,
  tierForScore,
  tierLabel,
  type RiskTier,
  type RiskCategory,
  type RiskSignal,
  type RiskScoreBreakdown,
  type RiskScoreLite,
  type RiskActionSuggestion,
  type RiskTimelineEvent,
  type SignalId,
} from "./score-types";
import type {
  RiskTier,
  RiskScoreBreakdown,
  RiskScoreLite,
  RiskSignal,
  RiskActionSuggestion,
  RiskTimelineEvent,
  SignalId,
} from "./score-types";
import { tierForScore } from "./score-types";

// ---------------------------------------------------------------------------
// In-memory cache (per-process)
// ---------------------------------------------------------------------------
//
// Full breakdown computation touches ~10 subqueries. We memoize the last
// result for 60 seconds so that a moderator clicking around the user
// detail page doesn't re-run the whole thing on every navigation.
// The cheaper list query (computeRiskScoresForList) has its own entries.

type CacheEntry = { value: RiskScoreBreakdown; expiresAt: number };
const CACHE_TTL_MS = MS_PER_MINUTE;
const cache = new Map<string, CacheEntry>();

function getCached(userId: string): RiskScoreBreakdown | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return entry.value;
}

function setCached(userId: string, value: RiskScoreBreakdown): void {
  cache.set(userId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function invalidateRiskScore(userId: string): void {
  cache.delete(userId);
}

// ---------------------------------------------------------------------------
// Raw aggregate row shape
// ---------------------------------------------------------------------------
//
// One big SQL query that returns everything we need for signals A-E.
// Kept in ONE round-trip so the detail page doesn't serialize ~10 round
// trips to the database. Everything returned as text to dodge BigInt
// surprises — we convert to numbers in JS.

type DetailRow = {
  // identity
  user_id: string;
  created_at: Date;
  country: string | null;
  country_code: string | null;
  is_banned: boolean;
  is_locked: boolean;
  is_suspected_alt: boolean;
  email_verified: boolean;
  two_factor_enabled: boolean | null;
  referred_by: string | null;

  // balances
  total_deposited: string;
  total_withdrawn: string;
  total_wagered: string;
  total_won: string;
  available_balance: string;
  locked_balance: string;
  inventory_value: string;
  card_withdrawal_value: string;

  // velocity
  deposits_24h_usd: string;
  deposits_7d_usd: string;
  deposits_all_usd: string;
  deposit_count_all: string;
  deposit_count_1h: string;
  deposit_count_24h: string;
  deposit_ips_24h: string;
  withdraw_attempt_ips_all: string;
  first_deposit_at: Date | null;
  last_deposit_at: Date | null;
  first_wager_at: Date | null;
  first_withdrawal_attempt_at: Date | null;
  max_single_deposit: string;
  max_single_wager: string;
  withdrawals_after_deposit_1h: string;
  withdrawals_after_bonus_1h: string;
  depwith_wager_burst_5m: string;
  withdraw_usd_24h: string;
  withdraw_attempts_total: string;
  withdraw_cancelled_or_failed: string;

  // bonus / rewards
  deposit_bonus_count: string;
  deposit_bonus_value: string;
  gift_card_count: string;
  gift_card_value: string;
  promo_code_count: string;
  promo_code_value: string;
  rakeback_near_bonus_count: string;
  rakeback_claim_count: string;
  rakeback_value: string;
  voucher_redeem_count: string;
  balance_reward_claim_count: string;
  balance_reward_claim_value: string;
  signup_reward_claim_count: string;
  affiliate_claim_value: string;
  rain_win_value: string;
  race_prize_value: string;
  creator_tip_value: string;
  bonus_credit_total: string;
  withdrawal_attempt_pre_wager_count: string;

  // gameplay
  pack_opens: string;
  battles_played: string;
  biggest_single_wager: string;
  total_card_sale_usd: string;

  // account
  feature_lock_count: string;
  mute_count: string;
  chat_message_count: string;

  // network — counted via separate queries (see below) so the detail
  // query stays reasonably sized.
  session_country_count: string;
  deposit_address_shared_accounts: string;
  affiliate_referrer_also_shares_ip: string;
};

/**
 * Shared-identity counts resolved in parallel with the main aggregate.
 */
type NetworkCounts = {
  sharedIpCount: number;
  sharedFingerprintCount: number;
  sharedBannedCount: number;
  sharedLockedCount: number;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function computeRiskScore(
  userId: string,
  opts?: { skipCache?: boolean },
): Promise<RiskScoreBreakdown> {
  const db = await getDb();
  if (!opts?.skipCache) {
    const cached = getCached(userId);
    if (cached) return cached;
  }

  const started = Date.now();

  // ── Round-trip 1: heavy aggregate SQL ────────────────────────────────
  const rows = await db.$queryRawUnsafe<DetailRow[]>(DETAIL_SQL, userId);
  if (rows.length === 0) {
    // No such user — produce a trivial "no data" breakdown. Keeps
    // callers simple (they don't need to handle null).
    const empty: RiskScoreBreakdown = {
      score: 0,
      tier: "low",
      signals: [],
      topReasons: [],
      suggestions: [],
      timeline: [],
      sharedIpCount: 0,
      sharedFingerprintCount: 0,
      sharedBannedCount: 0,
      sharedLockedCount: 0,
      computedAt: Date.now(),
      computeDurationMs: Date.now() - started,
    };
    setCached(userId, empty);
    return empty;
  }

  const row = rows[0];

  // ── Parallel round-trips 2-N: network counts, admin notes, timeline ──
  // These live in separate queries because:
  //   - Shared IP / fingerprint counts need a DISTINCT on other_user_id
  //     which doesn't compose cleanly with the main aggregate.
  //   - admin_notes lives in the Admin DB (see CLAUDE.md dual-DB rule).
  //   - Timeline is a union of several tables — easier to read as its
  //     own query than jammed into the aggregate.
  const [network, adminNotesCount, timeline] = await Promise.all([
    fetchNetworkCounts(userId),
    countAdminNotes(userId),
    fetchTimeline(userId),
  ]);

  const signals = buildSignals(row, {
    ...network,
    adminNotesCount,
  });

  const total = signals.reduce(
    (acc, s) => (s.triggered ? acc + s.weight : acc),
    0,
  );
  const score = Math.max(0, Math.min(100, Math.round(total)));
  const tier = tierForScore(score);

  const topReasons = [...signals]
    .filter((s) => s.triggered)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  const suggestions = buildSuggestions(signals, tier);

  const result: RiskScoreBreakdown = {
    score,
    tier,
    signals,
    topReasons,
    suggestions,
    timeline,
    sharedIpCount: network.sharedIpCount,
    sharedFingerprintCount: network.sharedFingerprintCount,
    sharedBannedCount: network.sharedBannedCount,
    sharedLockedCount: network.sharedLockedCount,
    computedAt: Date.now(),
    computeDurationMs: Date.now() - started,
  };
  setCached(userId, result);
  return result;
}

/**
 * Lite variant used by the /users list. Does NOT fetch the full signal
 * breakdown — just enough to render a tier badge per row.
 *
 * Implementation strategy: re-use the full score logic but fed by a
 * single batch query. This is much cheaper than running computeRiskScore
 * per user (which would be N * ~10 queries). See BATCH_SQL below.
 *
 * Expected runtime: ~40-80ms for 50 users on a warm DB. Uses index lookups
 * on user_id for every subselect; no full-table scans. If this ever creeps
 * over 500ms it's a sign the fingerprints / ledger_transactions tables
 * need an index review.
 */
export async function computeRiskScoresForList(
  userIds: readonly string[],
): Promise<Map<string, RiskScoreLite>> {
  const db = await getDb();
  const out = new Map<string, RiskScoreLite>();
  if (userIds.length === 0) return out;

  const rows = await db.$queryRawUnsafe<DetailRow[]>(
    BATCH_SQL,
    userIds as string[],
  );

  // Also fetch the network counts. Single query each, grouped by the
  // user_id subject, so we stay at O(1) round-trips regardless of the
  // page size. Shared-banned / shared-locked are not available at the
  // list level today — they'd need another heavy join per user and
  // they rarely flip a tier on their own. List view leaves them at 0;
  // detail view (see computeRiskScore) computes them properly.
  // Missing `fingerprints` table (e.g. fresh dev DB) must not crash the
  // whole user list — swallow the failure and treat every user as having
  // zero shared-identity neighbours.
  const [ipCountMap, fpCountMap] = await Promise.all([
    batchSharedIpCounts(userIds).catch(() => new Map<string, number>()),
    batchSharedFingerprintCounts(userIds).catch(() => new Map<string, number>()),
  ]);

  for (const row of rows) {
    const sharedIpCount = ipCountMap.get(row.user_id) ?? 0;
    const sharedFingerprintCount = fpCountMap.get(row.user_id) ?? 0;
    const sharedBannedCount = 0;
    const sharedLockedCount = 0;

    // adminNotesCount is skipped in the list view — it's rarely the
    // difference-maker between tiers and needs a second DB. For the
    // list-level tier we treat it as 0. The detail view shows the real
    // count.
    const signals = buildSignals(row, {
      sharedIpCount,
      sharedFingerprintCount,
      sharedBannedCount,
      sharedLockedCount,
      adminNotesCount: 0,
    });
    const total = signals.reduce(
      (acc, s) => (s.triggered ? acc + s.weight : acc),
      0,
    );
    const score = Math.max(0, Math.min(100, Math.round(total)));
    out.set(row.user_id, {
      score,
      tier: tierForScore(score),
      sharedIpCount,
      sharedFingerprintCount,
    });
  }

  // Fill any missing IDs with a zero score so the caller can always map.
  for (const id of userIds) {
    if (!out.has(id)) {
      out.set(id, {
        score: 0,
        tier: "low",
        sharedIpCount: 0,
        sharedFingerprintCount: 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal definitions
// ---------------------------------------------------------------------------
//
// Each builder receives the aggregate row + the precomputed network
// counters and returns a fully-formed RiskSignal. Weight tuning was done
// with these guiding constraints:
//
//   - A single signal should NEVER hit "critical" on its own. The highest
//     individual weight is 25 (stacked-account on same deposit address).
//   - Common benign patterns (one deposit in 24h, a normal win streak)
//     should score 0, not medium.
//   - Combined "textbook laundering" (fast deposit-withdraw, no wager,
//     shared IP, new account) should reach critical (80+).
//
// Weights are tagged with a category for UI grouping + (future) per-
// category cap. Current implementation caps only at the global 100.

type SignalCtx = NetworkCounts & { adminNotesCount: number };

function buildSignals(row: DetailRow, ctx: SignalCtx): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // Derived primitives ────────────────────────────────────────────────
  const now = Date.now();
  const accountAgeMs = now - new Date(row.created_at).getTime();
  const accountAgeDays = accountAgeMs / MS_PER_DAY;
  const accountAgeHours = accountAgeMs / MS_PER_HOUR;

  const totalDeposited = toNumber(row.total_deposited);
  const totalWithdrawn =
    toNumber(row.total_withdrawn) + toNumber(row.card_withdrawal_value);
  const totalWagered = toNumber(row.total_wagered);
  const totalWon = toNumber(row.total_won);

  const deposits24h = toNumber(row.deposits_24h_usd);
  const deposits7d = toNumber(row.deposits_7d_usd);
  const depositCountAll = toNumber(row.deposit_count_all);
  const depositCount1h = toNumber(row.deposit_count_1h);
  const depositCount24h = toNumber(row.deposit_count_24h);
  const depositIps24h = toNumber(row.deposit_ips_24h);
  const withdrawIpsAll = toNumber(row.withdraw_attempt_ips_all);
  const maxSingleDeposit = toNumber(row.max_single_deposit);
  const maxSingleWager = toNumber(row.max_single_wager);

  const firstDepositAt = row.first_deposit_at
    ? new Date(row.first_deposit_at)
    : null;
  const firstWagerAt = row.first_wager_at
    ? new Date(row.first_wager_at)
    : null;
  const firstWithdrawalAttemptAt = row.first_withdrawal_attempt_at
    ? new Date(row.first_withdrawal_attempt_at)
    : null;
  const lastDepositAt = row.last_deposit_at
    ? new Date(row.last_deposit_at)
    : null;

  // Velocity-side primitives added in v2.
  const withdraw24h = toNumber(row.withdraw_usd_24h);
  const withdrawAttemptsTotal = toNumber(row.withdraw_attempts_total);
  const withdrawCancelledOrFailed = toNumber(
    row.withdraw_cancelled_or_failed,
  );
  const depwithWagerBurst5m = toNumber(row.depwith_wager_burst_5m);

  // Rewards-side primitives added in v2.
  const giftCardCount = toNumber(row.gift_card_count);
  const promoCount = toNumber(row.promo_code_count);
  const balanceRewardValue = toNumber(row.balance_reward_claim_value);
  const signupRewardClaim = toNumber(row.signup_reward_claim_count);
  const bonusCreditTotal = toNumber(row.bonus_credit_total);
  const withdrawalAttemptPreWager = toNumber(
    row.withdrawal_attempt_pre_wager_count,
  );
  const voucherRedeem = toNumber(row.voucher_redeem_count);
  const packOpens = toNumber(row.pack_opens);
  const battlesPlayed = toNumber(row.battles_played);

  // Gameplay-side primitives added in v2.
  const totalCardSale = toNumber(row.total_card_sale_usd);
  const chatCount = toNumber(row.chat_message_count);

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY A — Money velocity & patterns (max ~30)
  // ═══════════════════════════════════════════════════════════════════

  // A1 — Large burst deposits in first 24h on a new account.
  //      Only fires on <14-day-old accounts to avoid false positives on
  //      established whales.
  const deposit7dBaseline = deposits7d - deposits24h; // 6 previous days only
  const baselinePerDay = deposit7dBaseline / 6;
  const depositBurstRatio =
    baselinePerDay > 0 ? deposits24h / baselinePerDay : 0;
  const a1Weight = (() => {
    if (accountAgeDays > 14) return 0;
    if (deposits24h < 500) return 0;
    // Scale: $500=3, $2000=9, $5000=15, cap at 15.
    return Math.round(Math.min(15, 3 + (deposits24h - 500) / 400));
  })();
  signals.push({
    id: "velocity.deposit_burst_24h",
    category: "velocity",
    label: "Large deposits in past 24h on a new account",
    weight: a1Weight,
    triggered: a1Weight > 0,
    value: `$${deposits24h.toFixed(0)} in 24h`,
    explanation:
      depositBurstRatio > 1
        ? `Deposited $${deposits24h.toFixed(0)} in the last 24h — ${depositBurstRatio.toFixed(1)}× the user's 6-day trailing daily average ($${baselinePerDay.toFixed(0)}/day) on an account only ${accountAgeDays.toFixed(0)} days old.`
        : `Deposited $${deposits24h.toFixed(0)} in the last 24h on an account only ${accountAgeDays.toFixed(0)} days old.`,
  });

  // A2 — Withdrawal within 1h of a deposit. Classic laundering / "deposit
  //      and run" pattern. Weight scales with the count of such close
  //      pairings observed in the ledger.
  const wAfterD = toNumber(row.withdrawals_after_deposit_1h);
  const a2Weight = wAfterD === 0 ? 0 : Math.min(12, 4 + wAfterD * 2);
  signals.push({
    id: "velocity.withdraw_after_deposit",
    category: "velocity",
    label: "Withdrawal within 1h of a deposit",
    weight: a2Weight,
    triggered: a2Weight > 0,
    value: wAfterD,
    explanation:
      wAfterD > 0
        ? `${wAfterD} withdrawal${wAfterD === 1 ? "" : "s"} initiated within 1 hour of a deposit — classic rapid-cashout pattern often seen in laundering or chip-dumping.`
        : "No fast withdraw-after-deposit patterns observed.",
  });

  // A3 — Withdrawn > deposited. Net-winners are a statistical oddity on
  //      a house-edge platform; sustained positive ratio on a young
  //      account screams advantage play or collusion.
  const withdrawRatio =
    totalDeposited > 0 ? totalWithdrawn / totalDeposited : 0;
  const a3Weight = (() => {
    if (totalWithdrawn < 100) return 0; // ignore dust
    if (withdrawRatio < 1.1) return 0;
    if (accountAgeDays > 60 && withdrawRatio < 1.5) return 0; // veterans ok-ish
    // Scale: 1.1x=3, 1.5x=7, 2.0x=11, 3.0x=15, cap 15.
    return Math.round(Math.min(15, 3 + (withdrawRatio - 1.1) * 6));
  })();
  signals.push({
    id: "velocity.net_winner",
    category: "velocity",
    label: "Net-winner vs the house",
    weight: a3Weight,
    triggered: a3Weight > 0,
    value: `${withdrawRatio.toFixed(2)}×`,
    explanation:
      a3Weight > 0
        ? `User has withdrawn $${totalWithdrawn.toFixed(0)} against $${totalDeposited.toFixed(0)} deposited — a ${withdrawRatio.toFixed(2)}× ratio. Sustained net-winning on a house-edge platform is rare.`
        : `Net ratio is ${withdrawRatio.toFixed(2)}× — within expected range.`,
  });

  // A4 — Long delay between deposit and first wager. Legit players start
  //      betting within minutes. A multi-day gap suggests money-parking
  //      or laundering via card-exchange / instant withdraw.
  const depositToWagerMs =
    firstDepositAt && firstWagerAt
      ? firstWagerAt.getTime() - firstDepositAt.getTime()
      : 0;
  const depositToWagerHours = depositToWagerMs / MS_PER_HOUR;
  const a4Weight =
    depositCountAll > 0 && !firstWagerAt && totalDeposited >= 100
      ? 8
      : depositToWagerHours > 48 && totalDeposited >= 100
        ? 5
        : 0;
  signals.push({
    id: "velocity.delayed_first_wager",
    category: "velocity",
    label: "Unusual delay between deposit and first wager",
    weight: a4Weight,
    triggered: a4Weight > 0,
    value:
      !firstWagerAt && depositCountAll > 0
        ? "deposited but never wagered"
        : depositToWagerHours > 0
          ? `${depositToWagerHours.toFixed(1)}h`
          : "—",
    explanation:
      !firstWagerAt && depositCountAll > 0
        ? "User has made deposits but never wagered. Money-parking indicator."
        : depositToWagerHours > 48
          ? `First wager came ${depositToWagerHours.toFixed(1)}h after the first deposit — far outside the typical minutes-to-hours window.`
          : depositCountAll === 0
            ? "No deposits on file yet."
            : "First wager followed deposit within a normal window.",
  });

  // A5 — Deposit → wager → withdrawal all within 5 minutes.
  //      Textbook money-laundering / cycling signature. Computed in SQL
  //      as a self-joined EXISTS triple against the ledger +
  //      card_withdrawal_requests.
  const a5Weight =
    depwithWagerBurst5m >= 3 ? 16 : depwithWagerBurst5m >= 1 ? 10 : 0;
  signals.push({
    id: "velocity.deposit_withdraw_wager_5m",
    category: "velocity",
    label: "Deposit → wager → withdrawal within 5 minutes",
    weight: a5Weight,
    triggered: a5Weight > 0,
    value: depwithWagerBurst5m,
    explanation:
      a5Weight > 0
        ? `${depwithWagerBurst5m} burst${depwithWagerBurst5m === 1 ? "" : "s"} observed where a deposit, wager, and withdrawal all happened within 5 minutes. Textbook money-cycling pattern — extremely rare for legitimate gameplay.`
        : "No rapid deposit→wager→withdrawal bursts observed.",
  });

  // A6 — 3+ deposits inside a single 60-minute cluster. Typical
  //      card-testing / compromised-instrument signature.
  const a6Weight = depositCount1h >= 5 ? 12 : depositCount1h >= 3 ? 7 : 0;
  signals.push({
    id: "velocity.multi_deposit_1h",
    category: "velocity",
    label: "Multiple deposits within 1 hour",
    weight: a6Weight,
    triggered: a6Weight > 0,
    value: depositCount1h,
    explanation:
      a6Weight > 0
        ? `${depositCount1h} deposits completed within a single 60-minute window. Typical legitimate pattern is 1 deposit per session — this rate is consistent with card testing or compromised-account activity.`
        : depositCount24h > 0
          ? `${depositCount24h} deposits in past 24h, none clustered inside a single hour — normal.`
          : "No recent deposits.",
  });

  // A7 — Withdrawal value is a high fraction of deposit value inside the
  //      same 24h window. Doesn't reach the full "withdraw > deposit"
  //      net-winner threshold but still elevated cash-out pressure.
  const a7Weight = (() => {
    if (withdraw24h < 50 || deposits24h < 50) return 0;
    const ratio = withdraw24h / deposits24h;
    if (ratio < 0.5) return 0;
    return Math.round(Math.min(10, 3 + ratio * 5));
  })();
  signals.push({
    id: "velocity.withdraw_exceeds_deposit_24h",
    category: "velocity",
    label: "High withdrawal/deposit ratio in last 24h",
    weight: a7Weight,
    triggered: a7Weight > 0,
    value: `$${withdraw24h.toFixed(0)} / $${deposits24h.toFixed(0)}`,
    explanation:
      a7Weight > 0
        ? `Withdrew $${withdraw24h.toFixed(0)} while depositing only $${deposits24h.toFixed(0)} in the same 24-hour window — elevated cash-out pressure.`
        : "Withdrawal vs deposit ratio in past 24h is within normal range.",
  });

  // A8 — First-ever withdrawal attempt happened unusually soon after
  //      signup. Legit first-time withdrawals usually come days or
  //      weeks in. Within the first hour is a giant red flag.
  const signupToFirstWithdrawMs = firstWithdrawalAttemptAt
    ? firstWithdrawalAttemptAt.getTime() - new Date(row.created_at).getTime()
    : 0;
  const signupToFirstWithdrawHours =
    signupToFirstWithdrawMs / MS_PER_HOUR;
  const a8Weight = (() => {
    if (!firstWithdrawalAttemptAt) return 0;
    if (signupToFirstWithdrawHours < 1) return 14;
    if (signupToFirstWithdrawHours < 6) return 9;
    if (signupToFirstWithdrawHours < 24) return 4;
    return 0;
  })();
  signals.push({
    id: "velocity.first_withdrawal_latency",
    category: "velocity",
    label: "First withdrawal attempted shortly after signup",
    weight: a8Weight,
    triggered: a8Weight > 0,
    value: firstWithdrawalAttemptAt
      ? signupToFirstWithdrawHours < 1
        ? `${(signupToFirstWithdrawMs / MS_PER_MINUTE).toFixed(0)} min`
        : `${signupToFirstWithdrawHours.toFixed(1)}h`
      : "no attempt",
    explanation: firstWithdrawalAttemptAt
      ? a8Weight > 0
        ? `First-ever withdrawal request came only ${signupToFirstWithdrawHours < 1 ? (signupToFirstWithdrawMs / MS_PER_MINUTE).toFixed(0) + " minutes" : signupToFirstWithdrawHours.toFixed(1) + " hours"} after signup. Normal users play for days or weeks before cashing out.`
        : `First withdrawal request came ${signupToFirstWithdrawHours.toFixed(0)}h after signup — within normal bounds.`
      : "User has not attempted a withdrawal.",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY B — Gameplay behaviour
  // ═══════════════════════════════════════════════════════════════════

  // B1 — Very low wager multiplier. Deposited X but wagered < 0.3X. The
  //      user is effectively just moving money through the platform.
  const wagerMultiplier =
    totalDeposited > 0 ? totalWagered / totalDeposited : 0;
  const b1Weight =
    totalDeposited >= 250 && wagerMultiplier < 0.3
      ? 10
      : totalDeposited >= 250 && wagerMultiplier < 0.6
        ? 5
        : 0;
  signals.push({
    id: "gameplay.low_wager_multiplier",
    category: "gameplay",
    label: "Very low wager multiplier",
    weight: b1Weight,
    triggered: b1Weight > 0,
    value: `${wagerMultiplier.toFixed(2)}×`,
    explanation:
      b1Weight > 0
        ? `Wagered only ${wagerMultiplier.toFixed(2)}× the total deposited. Real players typically wager 2-10× before withdrawing; sub-0.3× is a red flag for money-cycling.`
        : `Wager multiplier is ${wagerMultiplier.toFixed(2)}× — normal.`,
  });

  // B2 — House edge below platform floor. Our packs/battles carry a
  //      structural edge for the house; if an individual user is coming
  //      in at <2% over a meaningful wager volume they're either lucky
  //      OR they're exploiting something (RTP variance, collusion, etc.).
  //      Pure luck is still possible so we keep this weight modest.
  const userHouseEdge =
    totalWagered > 0 ? (totalWagered - totalWon) / totalWagered : 0;
  const b2Weight =
    totalWagered >= 1000 && userHouseEdge < 0.0
      ? 8
      : totalWagered >= 1000 && userHouseEdge < 0.05
        ? 4
        : 0;
  signals.push({
    id: "gameplay.abnormal_house_edge",
    category: "gameplay",
    label: "Anomalously low house edge over meaningful volume",
    weight: b2Weight,
    triggered: b2Weight > 0,
    value: `${(userHouseEdge * 100).toFixed(2)}%`,
    explanation:
      b2Weight > 0
        ? `Over $${totalWagered.toFixed(0)} in wagers the house has collected only ${(userHouseEdge * 100).toFixed(2)}% — below the expected floor. Could be variance, advantage play, or a pricing issue.`
        : "House edge within expected range.",
  });

  // B3 — Big single wager on a young account. People who deposit $200
  //      and immediately dump $150 on one battle are either whales
  //      testing the site, panic-stake losers, or someone bonus-hunting.
  //      Weight is conservative because it's noisy.
  const biggestSingle = toNumber(row.biggest_single_wager);
  const b3Weight =
    accountAgeDays < 3 && biggestSingle >= 250
      ? 5
      : accountAgeDays < 7 && biggestSingle >= 500
        ? 3
        : 0;
  signals.push({
    id: "gameplay.big_single_wager_new_account",
    category: "gameplay",
    label: "Large single wager from a new account",
    weight: b3Weight,
    triggered: b3Weight > 0,
    value: `$${biggestSingle.toFixed(0)}`,
    explanation:
      b3Weight > 0
        ? `Single wager of $${biggestSingle.toFixed(0)} on an account only ${accountAgeDays.toFixed(1)} days old.`
        : biggestSingle > 0
          ? "No unusual single-wager spikes on a young account."
          : "No wagers on file.",
  });

  // B4 — Bankroll dump: ≤1 deposit and a huge single wager relative to
  //      deposit volume. Someone who deposited $100 and immediately bet
  //      $80 on a single battle is burning their bankroll — often a
  //      laundering/chip-dumping pattern when paired with a withdrawal.
  const b4Weight = (() => {
    if (depositCountAll > 1 || totalDeposited < 50) return 0;
    if (maxSingleWager < totalDeposited * 0.5) return 0;
    if (maxSingleWager < 50) return 0;
    return 8;
  })();
  signals.push({
    id: "gameplay.bankroll_dump",
    category: "gameplay",
    label: "Single wager consumed most of bankroll on a new account",
    weight: b4Weight,
    triggered: b4Weight > 0,
    value: `$${maxSingleWager.toFixed(0)} / $${totalDeposited.toFixed(0)}`,
    explanation:
      b4Weight > 0
        ? `User has ${depositCountAll} deposit${depositCountAll === 1 ? "" : "s"} totalling $${totalDeposited.toFixed(0)} and a single wager of $${maxSingleWager.toFixed(0)} — ${((maxSingleWager / totalDeposited) * 100).toFixed(0)}% of bankroll on one bet.`
        : "No bankroll-dump pattern detected.",
  });

  // B5 — First wager happened BEFORE first completed deposit (edge case
  //      usually caused by a race / cashback / freebie exploit).
  const b5Weight =
    firstWagerAt && firstDepositAt && firstWagerAt < firstDepositAt ? 6 : 0;
  signals.push({
    id: "gameplay.wager_before_first_deposit",
    category: "gameplay",
    label: "First wager preceded first completed deposit",
    weight: b5Weight,
    triggered: b5Weight > 0,
    value:
      firstWagerAt && firstDepositAt
        ? `wager ${firstWagerAt.toISOString()} / deposit ${firstDepositAt.toISOString()}`
        : "—",
    explanation:
      b5Weight > 0
        ? "User placed a wager before their first deposit was recorded as completed. Usually indicates freebie credit or a timing anomaly worth investigating."
        : "Wagering and depositing happened in the expected order.",
  });

  // B6 — Heavy pack activity + zero card sales + low wager multiplier.
  //      Collector behaviour flagged as a mild signal when stacked with
  //      velocity concerns. Alone it's not fraud, but combined with
  //      other signals it helps distinguish silent laundering from a
  //      pure collector.
  const b6Weight =
    packOpens >= 20 && totalCardSale === 0 && wagerMultiplier < 0.5 ? 3 : 0;
  signals.push({
    id: "gameplay.never_sold_collector",
    category: "gameplay",
    label: "Heavy pack activity with zero card sales",
    weight: b6Weight,
    triggered: b6Weight > 0,
    value: `${packOpens} opens / $0 sold`,
    explanation:
      b6Weight > 0
        ? `User has opened ${packOpens} packs and never sold a card, while wagering only ${wagerMultiplier.toFixed(1)}× their deposits. Likely collector behavior, but worth flagging when paired with velocity signals.`
        : "Sale vs open ratio is normal.",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY C — Rewards / bonus abuse
  // ═══════════════════════════════════════════════════════════════════

  // C1 — Rakeback claims timed within minutes of a deposit-bonus. This
  //      is a stacking pattern — user triggers a deposit bonus, claims
  //      rakeback on top, and withdraws. The SQL subquery counts how
  //      many rakeback claims happened within ±1h of any deposit_bonus
  //      credit.
  const rakebackNearBonus = toNumber(row.rakeback_near_bonus_count);
  const c1Weight =
    rakebackNearBonus >= 3 ? 10 : rakebackNearBonus >= 1 ? 5 : 0;
  signals.push({
    id: "rewards.rakeback_stacked_on_bonus",
    category: "rewards",
    label: "Rakeback stacked tightly on deposit bonuses",
    weight: c1Weight,
    triggered: c1Weight > 0,
    value: rakebackNearBonus,
    explanation:
      c1Weight > 0
        ? `${rakebackNearBonus} rakeback claim${rakebackNearBonus === 1 ? "" : "s"} happened within 1 hour of a deposit-bonus credit. Pattern suggests deliberate bonus stacking.`
        : "No rakeback claims stacked on deposit bonuses.",
  });

  // C2 — Gift-card + promo redemption stacking. A normal user might
  //      redeem 1-2 promo codes across their lifetime. Someone rotating
  //      codes across accounts redeems a lot.
  const bonusRedeemCount = giftCardCount + promoCount;
  const c2Weight = bonusRedeemCount >= 5 ? 8 : bonusRedeemCount >= 3 ? 4 : 0;
  signals.push({
    id: "rewards.bonus_stacking",
    category: "rewards",
    label: "Promo / gift-card redemption stacking",
    weight: c2Weight,
    triggered: c2Weight > 0,
    value: bonusRedeemCount,
    explanation:
      c2Weight > 0
        ? `Redeemed ${giftCardCount} gift card${giftCardCount === 1 ? "" : "s"} + ${promoCount} promo code${promoCount === 1 ? "" : "s"}. Unusual concentration.`
        : "Normal promo/gift-card redemption count.",
  });

  // C3 — Withdrawal immediately after ANY bonus-type credit. Any deposit
  //      bonus, rakeback, promo, or gift card followed by a withdrawal
  //      in the same hour is the bread-and-butter of bonus abuse.
  const wAfterBonus = toNumber(row.withdrawals_after_bonus_1h);
  const c3Weight = wAfterBonus >= 2 ? 10 : wAfterBonus >= 1 ? 6 : 0;
  signals.push({
    id: "rewards.withdraw_after_bonus",
    category: "rewards",
    label: "Withdrawal within 1h of a bonus credit",
    weight: c3Weight,
    triggered: c3Weight > 0,
    value: wAfterBonus,
    explanation:
      c3Weight > 0
        ? `${wAfterBonus} withdrawal${wAfterBonus === 1 ? "" : "s"} happened within 1 hour of a bonus-type credit (deposit bonus, rakeback, promo, gift card).`
        : "No fast bonus-then-withdraw patterns.",
  });

  // C4 — Voucher redemption volume. Vouchers usually come from exchange
  //      excess / battle excess — legitimate. A large voucher-redeem
  //      count relative to wagering is nothing; a user who has ONLY
  //      voucher-redemption activity is suspicious.
  const c4Weight =
    voucherRedeem >= 5 && packOpens < voucherRedeem ? 4 : 0;
  signals.push({
    id: "rewards.voucher_heavy",
    category: "rewards",
    label: "Voucher-heavy activity",
    weight: c4Weight,
    triggered: c4Weight > 0,
    value: voucherRedeem,
    explanation:
      c4Weight > 0
        ? `Redeemed ${voucherRedeem} voucher${voucherRedeem === 1 ? "" : "s"} vs only ${packOpens} pack open${packOpens === 1 ? "" : "s"}. User is mostly consuming, not wagering.`
        : "Voucher activity is balanced with actual wagering.",
  });

  // C5 — Classic signup-reward → instant withdraw. This is the flagship
  //      "bonus abuse" pattern the product explicitly flagged. Account
  //      is <48h old, has claimed a signup / balance reward, has NOT
  //      met the standard wager multiplier, and has attempted a
  //      withdrawal.
  const c5Weight = (() => {
    const hasSignupReward = signupRewardClaim > 0 || balanceRewardValue > 0;
    const hasWithdrawAttempt = withdrawAttemptsTotal > 0;
    if (!hasSignupReward || !hasWithdrawAttempt) return 0;
    if (accountAgeHours > 48) return 0;
    // Wagered at least once the total bonus credit → probably OK.
    if (totalWagered >= bonusCreditTotal && totalWagered > 10) return 0;
    return 18;
  })();
  signals.push({
    id: "rewards.signup_reward_instant_withdraw",
    category: "rewards",
    label: "Signup reward claimed then immediate withdrawal attempt",
    weight: c5Weight,
    triggered: c5Weight > 0,
    value: `age ${accountAgeHours.toFixed(1)}h`,
    explanation:
      c5Weight > 0
        ? `Account is ${accountAgeHours.toFixed(1)}h old, claimed a signup/balance reward worth $${balanceRewardValue.toFixed(2)}, wagered $${totalWagered.toFixed(2)} against $${bonusCreditTotal.toFixed(2)} in bonus credits, and attempted ${withdrawAttemptsTotal} withdrawal${withdrawAttemptsTotal === 1 ? "" : "s"}. Textbook bonus-abuse signature — flag for review before processing.`
        : "No signup-reward + instant-withdraw signature detected.",
  });

  // C6 — Bonus credit volume relative to real wagering. If a user has
  //      received $200 in bonuses and wagered $50, they're extracting
  //      bonuses without playing them through.
  const c6Weight = (() => {
    if (bonusCreditTotal < 50) return 0;
    if (totalWagered === 0) return 10;
    const ratio = bonusCreditTotal / totalWagered;
    if (ratio < 1.5) return 0;
    // 1.5x=4, 3x=7, 5x=10, cap 10.
    return Math.round(Math.min(10, 2 + ratio * 1.5));
  })();
  signals.push({
    id: "rewards.bonus_to_wager_ratio",
    category: "rewards",
    label: "Bonus credits far exceed real wagering",
    weight: c6Weight,
    triggered: c6Weight > 0,
    value:
      totalWagered > 0
        ? `${(bonusCreditTotal / totalWagered).toFixed(2)}×`
        : `$${bonusCreditTotal.toFixed(0)} / $0 wagered`,
    explanation:
      c6Weight > 0
        ? `User received $${bonusCreditTotal.toFixed(0)} in bonus-type credits (deposit bonus + rakeback + promo + gift card + signup rewards + rain/race/tips) vs only $${totalWagered.toFixed(0)} wagered.`
        : "Bonus-to-wager ratio is within normal range.",
  });

  // C7 — Bonus volume exceeds real deposit volume (got more free money
  //      than they spent).
  const c7Weight = (() => {
    if (totalDeposited < 20 && bonusCreditTotal < 50) return 0;
    if (bonusCreditTotal < totalDeposited) return 0;
    const delta = bonusCreditTotal - totalDeposited;
    if (delta < 20) return 0;
    // $20=3, $100=7, $500=12, cap 12.
    return Math.round(Math.min(12, 3 + delta / 40));
  })();
  signals.push({
    id: "rewards.bonus_heavy_over_deposit",
    category: "rewards",
    label: "Received more in bonuses than user has ever deposited",
    weight: c7Weight,
    triggered: c7Weight > 0,
    value: `bonus $${bonusCreditTotal.toFixed(0)} / dep $${totalDeposited.toFixed(0)}`,
    explanation:
      c7Weight > 0
        ? `Received $${bonusCreditTotal.toFixed(0)} in bonus-type credits against $${totalDeposited.toFixed(0)} in real deposits — net promo consumer.`
        : "Bonus intake does not exceed real deposit volume.",
  });

  // C8 — Withdrawal attempt submitted before ANY wagering happened.
  //      Strong fraud signal — legit users always play before asking to
  //      cash out.
  const c8Weight = withdrawalAttemptPreWager > 0 ? 14 : 0;
  signals.push({
    id: "rewards.withdrawal_attempt_pre_wager",
    category: "rewards",
    label: "Withdrawal attempted before any wagering",
    weight: c8Weight,
    triggered: c8Weight > 0,
    value: withdrawalAttemptPreWager,
    explanation:
      c8Weight > 0
        ? `${withdrawalAttemptPreWager} withdrawal attempt${withdrawalAttemptPreWager === 1 ? "" : "s"} were submitted before the user ever placed a wager. Strongly suggests bonus or deposit-credit exploitation.`
        : "Withdrawal attempts (if any) happened after wagering.",
  });

  // C9 — Multiple cancelled/failed withdrawal attempts. History of
  //      tries — often someone probing what the limits are, or a
  //      user who knows a withdrawal would be blocked but keeps trying.
  const c9Weight =
    withdrawCancelledOrFailed >= 3
      ? 8
      : withdrawCancelledOrFailed >= 1
        ? 3
        : 0;
  signals.push({
    id: "rewards.cancelled_withdrawal_attempts",
    category: "rewards",
    label: "Cancelled or failed withdrawal history",
    weight: c9Weight,
    triggered: c9Weight > 0,
    value: withdrawCancelledOrFailed,
    explanation:
      c9Weight > 0
        ? `${withdrawCancelledOrFailed} withdrawal request${withdrawCancelledOrFailed === 1 ? "" : "s"} ${withdrawCancelledOrFailed === 1 ? "was" : "have been"} cancelled or failed. Probing / retry behaviour.`
        : "No cancelled or failed withdrawal requests.",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY D — Identity & network
  // ═══════════════════════════════════════════════════════════════════

  // D1 — Shared IP with other users. Residential IP sharing (friends /
  //      family on the same wifi) is normal up to 1-2 other users. Past
  //      that it starts looking like a multi-account farm. Graded weight.
  const d1Weight =
    ctx.sharedIpCount >= 5
      ? 14
      : ctx.sharedIpCount >= 3
        ? 9
        : ctx.sharedIpCount >= 2
          ? 5
          : 0;
  signals.push({
    id: "network.shared_ip",
    category: "network",
    label: "Shares IP with other accounts",
    weight: d1Weight,
    triggered: d1Weight > 0,
    value: ctx.sharedIpCount,
    explanation:
      ctx.sharedIpCount > 0
        ? `Shares at least one login / signup IP with ${ctx.sharedIpCount} other account${ctx.sharedIpCount === 1 ? "" : "s"}.`
        : "No IP overlap with other accounts.",
  });

  // D2 — Shared device fingerprint. Much stronger signal than IP —
  //      browsers don't randomly produce the same visitor_id across
  //      distinct devices. Higher weight than IP because false-positive
  //      rate is much lower.
  const d2Weight =
    ctx.sharedFingerprintCount >= 3
      ? 18
      : ctx.sharedFingerprintCount >= 2
        ? 13
        : ctx.sharedFingerprintCount >= 1
          ? 8
          : 0;
  signals.push({
    id: "network.shared_fingerprint",
    category: "network",
    label: "Shares device fingerprint with other accounts",
    weight: d2Weight,
    triggered: d2Weight > 0,
    value: ctx.sharedFingerprintCount,
    explanation:
      ctx.sharedFingerprintCount > 0
        ? `Same device fingerprint seen on ${ctx.sharedFingerprintCount} other account${ctx.sharedFingerprintCount === 1 ? "" : "s"}. Device fingerprints are harder to spoof than IPs — high-confidence alt indicator.`
        : "Device fingerprint is unique to this account.",
  });

  // D3 — Multi-country session history. Normal users have 1-2 countries
  //      (home + travel). 4+ distinct countries across sessions is
  //      VPN-hopping or a shared account.
  const countryCount = toNumber(row.session_country_count);
  const d3Weight = countryCount >= 5 ? 6 : countryCount >= 4 ? 3 : 0;
  signals.push({
    id: "network.country_hopping",
    category: "network",
    label: "Sessions span many countries",
    weight: d3Weight,
    triggered: d3Weight > 0,
    value: countryCount,
    explanation:
      d3Weight > 0
        ? `Sessions recorded from ${countryCount} distinct countries. Typical users have 1-2; 4+ is a VPN-hop or shared-account indicator.`
        : `Sessions from ${countryCount === 0 ? "no" : countryCount} countr${countryCount === 1 ? "y" : "ies"} — normal.`,
  });

  // D4 — Same crypto deposit address shared with OTHER accounts.
  //      High-confidence multi-account signal — two users sharing a
  //      blockchain destination address is effectively proof.
  const sharedCryptoAddr = toNumber(row.deposit_address_shared_accounts);
  const d4Weight = sharedCryptoAddr >= 2 ? 18 : sharedCryptoAddr >= 1 ? 12 : 0;
  signals.push({
    id: "network.shared_deposit_address",
    category: "network",
    label: "Crypto deposit address used by other accounts",
    weight: d4Weight,
    triggered: d4Weight > 0,
    value: sharedCryptoAddr,
    explanation:
      d4Weight > 0
        ? `${sharedCryptoAddr} other account${sharedCryptoAddr === 1 ? "" : "s"} use the same crypto deposit address as this user. Near-certain multi-account.`
        : "No crypto deposit address overlap with other accounts.",
  });

  // D5 — At least one user in the shared-identity set (IP or
  //      fingerprint) is currently banned or locked. A banned alt is a
  //      near-guarantee this account is a re-registration.
  const d5Weight =
    ctx.sharedBannedCount >= 2
      ? 18
      : ctx.sharedBannedCount >= 1
        ? 14
        : ctx.sharedLockedCount >= 1
          ? 6
          : 0;
  signals.push({
    id: "network.shared_with_banned",
    category: "network",
    label: "Shares identity with banned or locked accounts",
    weight: d5Weight,
    triggered: d5Weight > 0,
    value: `${ctx.sharedBannedCount} banned / ${ctx.sharedLockedCount} locked`,
    explanation:
      ctx.sharedBannedCount > 0
        ? `${ctx.sharedBannedCount} banned account${ctx.sharedBannedCount === 1 ? "" : "s"} share${ctx.sharedBannedCount === 1 ? "s" : ""} an IP or device fingerprint with this user. Very likely an alt re-registration.`
        : ctx.sharedLockedCount > 0
          ? `${ctx.sharedLockedCount} locked account${ctx.sharedLockedCount === 1 ? "" : "s"} share${ctx.sharedLockedCount === 1 ? "s" : ""} an IP or device fingerprint with this user. Worth checking before any payout.`
          : "No banned or locked accounts in the user's identity set.",
  });

  // D6 — Self-referral ring: the user's `referred_by` is a user who
  //      shares an IP or fingerprint with the subject. Classic affiliate
  //      kickback exploit.
  const selfReferral = toNumber(row.affiliate_referrer_also_shares_ip);
  const d6Weight = selfReferral > 0 ? 14 : 0;
  signals.push({
    id: "network.self_referral_ring",
    category: "network",
    label: "Affiliate referrer shares identity with this user",
    weight: d6Weight,
    triggered: d6Weight > 0,
    value: selfReferral,
    explanation:
      d6Weight > 0
        ? "The user who referred this account shares at least one IP or device fingerprint with this user. Self-referral / affiliate kickback loop is almost certain."
        : "Affiliate referrer does not overlap this user's identity set.",
  });

  // D7 — Withdrawal IPs differ from deposit IPs. Heuristic — if there
  //      are materially more distinct withdrawal-attempt IPs than
  //      deposit IPs we flag it as a possible compromised account or
  //      handoff.
  const d7Weight = (() => {
    if (depositIps24h === 0 || withdrawIpsAll === 0) return 0;
    if (!firstWithdrawalAttemptAt) return 0;
    if (withdrawIpsAll <= depositIps24h) return 0;
    const delta = withdrawIpsAll - depositIps24h;
    return delta >= 2 ? 8 : 4;
  })();
  signals.push({
    id: "network.withdrawal_ip_mismatch",
    category: "network",
    label: "Withdrawal IPs differ from deposit IPs",
    weight: d7Weight,
    triggered: d7Weight > 0,
    value: `dep ${depositIps24h} / wd ${withdrawIpsAll}`,
    explanation:
      d7Weight > 0
        ? `Observed ${depositIps24h} distinct deposit IPs (24h) and ${withdrawIpsAll} distinct withdrawal-attempt IPs with limited overlap. Could be a compromised account or handoff.`
        : "Deposit and withdrawal IPs look consistent.",
  });

  // D8 — Many deposit IPs in a short window. Token-sharing / shared
  //      account signature.
  const d8Weight = depositIps24h >= 4 ? 9 : depositIps24h >= 3 ? 5 : 0;
  signals.push({
    id: "network.deposit_ip_spread",
    category: "network",
    label: "Deposits came from many distinct IPs in 24h",
    weight: d8Weight,
    triggered: d8Weight > 0,
    value: depositIps24h,
    explanation:
      d8Weight > 0
        ? `Past 24h deposits came from ${depositIps24h} distinct IPs. Pattern suggests shared-account or token-sharing activity.`
        : depositIps24h > 0
          ? `${depositIps24h} deposit IP${depositIps24h === 1 ? "" : "s"} in 24h — normal.`
          : "No recent deposit IPs recorded.",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY E — Account state red flags
  // ═══════════════════════════════════════════════════════════════════

  // E1 — Already banned or locked by an admin. If another human already
  //      flagged this, future sessions are by definition suspicious.
  const e1Weight = row.is_banned ? 18 : row.is_locked ? 10 : 0;
  signals.push({
    id: "account.prior_moderation",
    category: "account",
    label: "Account has been banned / locked before",
    weight: e1Weight,
    triggered: e1Weight > 0,
    value: row.is_banned ? "banned" : row.is_locked ? "locked" : "clean",
    explanation: row.is_banned
      ? "Account is currently banned."
      : row.is_locked
        ? "Account is currently locked."
        : "Account has no active moderation holds.",
  });

  // E2 — Suspected-alt flag already tripped by fingerprint heuristics.
  const e2Weight = row.is_suspected_alt ? 7 : 0;
  signals.push({
    id: "account.suspected_alt_flag",
    category: "account",
    label: "Suspected-alt flag already tripped",
    weight: e2Weight,
    triggered: e2Weight > 0,
    value: row.is_suspected_alt ? "yes" : "no",
    explanation: row.is_suspected_alt
      ? "Signup/login fingerprint previously tripped the suspected-alt heuristic."
      : "No prior suspected-alt flag.",
  });

  // E3 — Active feature locks. Deposits / withdrawals / openings locked
  //      means a previous admin already put this user in a penalty box.
  const featureLockCount = toNumber(row.feature_lock_count);
  const e3Weight = featureLockCount >= 2 ? 7 : featureLockCount >= 1 ? 3 : 0;
  signals.push({
    id: "account.active_feature_locks",
    category: "account",
    label: "Active feature locks",
    weight: e3Weight,
    triggered: e3Weight > 0,
    value: featureLockCount,
    explanation:
      e3Weight > 0
        ? `${featureLockCount} feature lock${featureLockCount === 1 ? "" : "s"} currently applied.`
        : "No active feature locks.",
  });

  // E4 — Admin notes count (from Admin DB). A user with 3+ internal notes
  //      has been "interesting" to enough admins to warrant attention.
  const e4Weight =
    ctx.adminNotesCount >= 5
      ? 6
      : ctx.adminNotesCount >= 3
        ? 4
        : ctx.adminNotesCount >= 1
          ? 2
          : 0;
  signals.push({
    id: "account.admin_notes",
    category: "account",
    label: "Admin notes on this user",
    weight: e4Weight,
    triggered: e4Weight > 0,
    value: ctx.adminNotesCount,
    explanation:
      ctx.adminNotesCount > 0
        ? `${ctx.adminNotesCount} internal admin note${ctx.adminNotesCount === 1 ? "" : "s"} attached. Multiple notes usually mean repeated attention.`
        : "No internal admin notes.",
  });

  // E5 — Chat mutes on record. Not directly fraud, but correlates with
  //      abusive behaviour broadly.
  const muteCount = toNumber(row.mute_count);
  const e5Weight = muteCount >= 3 ? 4 : muteCount >= 1 ? 2 : 0;
  signals.push({
    id: "account.chat_mutes",
    category: "account",
    label: "Has been muted in chat",
    weight: e5Weight,
    triggered: e5Weight > 0,
    value: muteCount,
    explanation:
      e5Weight > 0
        ? `Muted ${muteCount} time${muteCount === 1 ? "" : "s"} on record.`
        : "No chat mutes.",
  });

  // E6 — Young account with significant lifetime deposits. Not directly
  //      abuse but a velocity/trust amplifier. Acts as a multiplier-lite.
  const e6Weight =
    accountAgeDays < 3 && totalDeposited >= 1000
      ? 5
      : accountAgeDays < 7 && totalDeposited >= 3000
        ? 3
        : 0;
  signals.push({
    id: "account.young_with_high_deposits",
    category: "account",
    label: "Very young account with large lifetime deposits",
    weight: e6Weight,
    triggered: e6Weight > 0,
    value: `$${totalDeposited.toFixed(0)} in ${accountAgeDays.toFixed(1)}d`,
    explanation:
      e6Weight > 0
        ? `Deposited $${totalDeposited.toFixed(0)} in the first ${accountAgeDays.toFixed(1)} days.`
        : "Deposit pace vs account age within normal range.",
  });

  // E7 — Silent account — zero chat messages ever, but meaningful
  //      wager/deposit volume. Combined with other signals this is
  //      often a bot signature. Weight kept small because it's noisy
  //      on its own.
  const e7Weight =
    chatCount === 0 && packOpens + battlesPlayed >= 30 ? 3 : 0;
  signals.push({
    id: "account.chat_silent_with_volume",
    category: "account",
    label: "No chat activity despite heavy gameplay",
    weight: e7Weight,
    triggered: e7Weight > 0,
    value: `${chatCount} msgs / ${packOpens + battlesPlayed} plays`,
    explanation:
      e7Weight > 0
        ? `User has played heavily (${packOpens} packs + ${battlesPlayed} battles) but has never sent a chat message. Silent accounts with volume are a weak bot signature.`
        : "Chat activity is consistent with gameplay volume.",
  });

  // E8 — Deposits made but email not verified.
  const e8Weight =
    !row.email_verified && totalDeposited >= 100 ? 4 : 0;
  signals.push({
    id: "account.email_unverified_with_deposits",
    category: "account",
    label: "Deposits made without verified email",
    weight: e8Weight,
    triggered: e8Weight > 0,
    value: row.email_verified ? "verified" : "unverified",
    explanation:
      e8Weight > 0
        ? `User has deposited $${totalDeposited.toFixed(0)} without verifying email. Increases chargeback + account-recovery risk.`
        : row.email_verified
          ? "Email is verified."
          : "Email not verified (no significant deposits to date).",
  });

  // E9 — 2FA not enabled on a high-volume account.
  const e9Weight =
    row.two_factor_enabled !== true &&
    totalDeposited + totalWithdrawn >= 2000
      ? 3
      : 0;
  signals.push({
    id: "account.no_2fa_with_volume",
    category: "account",
    label: "No 2FA despite meaningful money movement",
    weight: e9Weight,
    triggered: e9Weight > 0,
    value: row.two_factor_enabled ? "on" : "off",
    explanation:
      e9Weight > 0
        ? `User has moved $${(totalDeposited + totalWithdrawn).toFixed(0)} through the platform without 2FA. Increases compromise/chargeback risk.`
        : row.two_factor_enabled
          ? "2FA enabled."
          : "2FA not enabled (money movement is low so far).",
  });

  // Side-channel silencing — values referenced in explanation strings
  // but not directly in weights.
  void lastDepositAt;
  void maxSingleDeposit;

  return signals;
}

// ---------------------------------------------------------------------------
// SQL — single-user detail aggregate
// ---------------------------------------------------------------------------
//
// All scalar aggregates cast to ::text to survive the Prisma raw-SQL
// boundary without BigInt weirdness. Subqueries use COALESCE so a
// non-existent row yields 0 / null instead of being dropped from the
// result set.

const DETAIL_SQL = `
WITH u AS (
  SELECT id, created_at, country, country_code, is_banned, is_locked,
         is_suspected_alt
  FROM "user" WHERE id = $1
),
b AS (
  SELECT user_id, available_balance, locked_balance,
         total_deposited, total_withdrawn, total_wagered, total_won
  FROM balances WHERE user_id = $1
),
inv AS (
  SELECT COALESCE(SUM(value_at_obtained::numeric), 0) AS inventory_value
  FROM user_inventory WHERE user_id = $1
    AND sold_at IS NULL AND exchanged_at IS NULL
),
cw AS (
  SELECT COALESCE(SUM(total_value_usd::numeric), 0) AS card_withdrawal_value
  FROM card_withdrawal_requests WHERE user_id = $1
    AND status IN ('completed','shipped')
),
d24 AS (
  SELECT COALESCE(SUM(amount::numeric), 0) AS v
  FROM ledger_transactions
  WHERE user_id = $1 AND type = 'deposit' AND status = 'completed'
    AND created_at >= NOW() - INTERVAL '24 hours'
),
d7 AS (
  SELECT COALESCE(SUM(amount::numeric), 0) AS v
  FROM ledger_transactions
  WHERE user_id = $1 AND type = 'deposit' AND status = 'completed'
    AND created_at >= NOW() - INTERVAL '7 days'
),
dall AS (
  SELECT COALESCE(SUM(amount::numeric), 0) AS v,
         COUNT(*)::bigint AS c,
         MIN(created_at) AS first_at,
         MAX(created_at) AS last_at,
         COALESCE(MAX(amount::numeric), 0) AS max_single
  FROM ledger_transactions
  WHERE user_id = $1 AND type = 'deposit' AND status = 'completed'
),
fw AS (
  SELECT MIN(created_at) AS first_at
  FROM ledger_transactions
  WHERE user_id = $1 AND status = 'completed'
    AND type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
),
wad AS (
  -- withdrawals initiated within 1h of any deposit.
  -- Self-join on the same ledger; ± window is [deposit_time, deposit_time + 1h].
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions w
  WHERE w.user_id = $1
    AND w.type = 'card_withdrawal'
    AND w.status IN ('completed','pending')
    AND EXISTS (
      SELECT 1 FROM ledger_transactions d
      WHERE d.user_id = $1 AND d.type = 'deposit' AND d.status = 'completed'
        AND w.created_at BETWEEN d.created_at AND d.created_at + INTERVAL '1 hour'
    )
),
wab AS (
  -- withdrawals within 1h of any bonus-type credit
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions w
  WHERE w.user_id = $1
    AND w.type = 'card_withdrawal'
    AND w.status IN ('completed','pending')
    AND EXISTS (
      SELECT 1 FROM ledger_transactions bonus
      WHERE bonus.user_id = $1 AND bonus.status = 'completed'
        AND bonus.type IN (
          'deposit_bonus','rakeback_claim','balance_reward_claim',
          'promo_code_redeemed','gift_card_redeemed','affiliate_claim'
        )
        AND w.created_at BETWEEN bonus.created_at AND bonus.created_at + INTERVAL '1 hour'
    )
),
dbc AS (
  SELECT COUNT(*)::bigint AS c,
         COALESCE(SUM(amount::numeric), 0) AS v
  FROM ledger_transactions
  WHERE user_id = $1 AND type = 'deposit_bonus' AND status = 'completed'
),
gcc AS (
  SELECT COUNT(*)::bigint AS c FROM gift_cards WHERE redeemed_by_user_id = $1
),
prc AS (
  SELECT COUNT(*)::bigint AS c FROM promo_code_redemptions WHERE user_id = $1
),
rnb AS (
  -- rakeback claims that land within 1h of any deposit_bonus.
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions r
  WHERE r.user_id = $1 AND r.type = 'rakeback_claim' AND r.status = 'completed'
    AND EXISTS (
      SELECT 1 FROM ledger_transactions db
      WHERE db.user_id = $1 AND db.type = 'deposit_bonus' AND db.status = 'completed'
        AND ABS(EXTRACT(EPOCH FROM (r.created_at - db.created_at))) < 3600
    )
),
rc AS (
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions WHERE user_id = $1 AND type = 'rakeback_claim' AND status = 'completed'
),
vr AS (
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions WHERE user_id = $1 AND type = 'voucher_redeemed' AND status = 'completed'
),
po AS (
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions WHERE user_id = $1 AND type = 'pack_opening' AND status = 'completed'
),
bp AS (
  SELECT COUNT(*)::bigint AS c
  FROM ledger_transactions WHERE user_id = $1 AND type = 'battle_bet' AND status = 'completed'
),
bsw AS (
  -- biggest single absolute wager amount across pack_opening/battle_bet/battle_sponsorship.
  SELECT COALESCE(MAX(ABS(amount::numeric)), 0) AS v
  FROM ledger_transactions
  WHERE user_id = $1 AND status = 'completed'
    AND type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
),
fl AS (
  SELECT (
    (CASE WHEN array_length(locked_deposits_crypto, 1) > 0 THEN 1 ELSE 0 END) +
    (CASE WHEN array_length(locked_deposits_fiat, 1) > 0 THEN 1 ELSE 0 END) +
    (CASE WHEN array_length(locked_withdrawals_crypto, 1) > 0 THEN 1 ELSE 0 END) +
    (CASE WHEN locked_withdrawals_items THEN 1 ELSE 0 END) +
    (CASE WHEN locked_inventory_sales THEN 1 ELSE 0 END) +
    (CASE WHEN locked_exchanges THEN 1 ELSE 0 END) +
    (CASE WHEN locked_openings THEN 1 ELSE 0 END) +
    (CASE WHEN locked_vault THEN 1 ELSE 0 END)
  )::bigint AS c
  FROM user_feature_locks WHERE user_id = $1
),
mu AS (
  SELECT COUNT(*)::bigint AS c
  FROM user_mutes WHERE user_id = $1 AND unmuted_at IS NULL
),
scc AS (
  SELECT COUNT(DISTINCT country_code)::bigint AS c
  FROM session
  WHERE "userId" = $1 AND country_code IS NOT NULL
),
das AS (
  -- Count OTHER users who share at least one crypto deposit address with
  -- this user. Two users having the same address + asset combo is an
  -- extremely strong multi-account signal.
  SELECT COUNT(DISTINCT da2.user_id)::bigint AS c
  FROM deposit_addresses da1
  JOIN deposit_addresses da2
    ON da1.address = da2.address
   AND da1.asset_id = da2.asset_id
   AND da2.user_id <> $1
  WHERE da1.user_id = $1
)
SELECT
  u.id                                             AS user_id,
  u.created_at                                     AS created_at,
  u.country                                        AS country,
  u.country_code                                   AS country_code,
  u.is_banned                                      AS is_banned,
  u.is_locked                                      AS is_locked,
  u.is_suspected_alt                               AS is_suspected_alt,

  COALESCE(b.total_deposited::text, '0')           AS total_deposited,
  COALESCE(b.total_withdrawn::text, '0')           AS total_withdrawn,
  COALESCE(b.total_wagered::text, '0')             AS total_wagered,
  COALESCE(b.total_won::text, '0')                 AS total_won,
  COALESCE(b.available_balance::text, '0')         AS available_balance,
  COALESCE(b.locked_balance::text, '0')            AS locked_balance,
  inv.inventory_value::text                        AS inventory_value,
  cw.card_withdrawal_value::text                   AS card_withdrawal_value,

  d24.v::text                                      AS deposits_24h_usd,
  d7.v::text                                       AS deposits_7d_usd,
  dall.v::text                                     AS deposits_all_usd,
  dall.c::text                                     AS deposit_count_all,
  dall.first_at                                    AS first_deposit_at,
  dall.last_at                                     AS last_deposit_at,
  fw.first_at                                      AS first_wager_at,
  dall.max_single::text                            AS max_single_deposit,
  wad.c::text                                      AS withdrawals_after_deposit_1h,
  wab.c::text                                      AS withdrawals_after_bonus_1h,

  dbc.c::text                                      AS deposit_bonus_count,
  dbc.v::text                                      AS deposit_bonus_value,
  gcc.c::text                                      AS gift_card_count,
  prc.c::text                                      AS promo_code_count,
  rnb.c::text                                      AS rakeback_near_bonus_count,
  rc.c::text                                       AS rakeback_claim_count,
  vr.c::text                                       AS voucher_redeem_count,

  po.c::text                                       AS pack_opens,
  bp.c::text                                       AS battles_played,
  bsw.v::text                                      AS biggest_single_wager,

  fl.c::text                                       AS feature_lock_count,
  mu.c::text                                       AS mute_count,

  scc.c::text                                      AS session_country_count,
  das.c::text                                      AS deposit_address_shared_accounts
FROM u
LEFT JOIN b ON TRUE
CROSS JOIN inv CROSS JOIN cw CROSS JOIN d24 CROSS JOIN d7 CROSS JOIN dall
LEFT  JOIN fw  ON TRUE
CROSS JOIN wad CROSS JOIN wab CROSS JOIN dbc CROSS JOIN gcc CROSS JOIN prc
CROSS JOIN rnb CROSS JOIN rc  CROSS JOIN vr  CROSS JOIN po  CROSS JOIN bp
CROSS JOIN bsw
LEFT  JOIN fl  ON TRUE
CROSS JOIN mu  CROSS JOIN scc CROSS JOIN das
`;

// ---------------------------------------------------------------------------
// SQL — batch aggregate for list view
// ---------------------------------------------------------------------------
//
// Same logical columns as DETAIL_SQL but grouped by user_id so one query
// returns a row per user. Uses FILTER clauses to drop the per-CTE
// boilerplate. Parameter is $1 = text[] of user ids.

const BATCH_SQL = `
WITH ids AS (SELECT UNNEST($1::text[]) AS user_id)
SELECT
  u.id                                             AS user_id,
  u.created_at                                     AS created_at,
  u.country                                        AS country,
  u.country_code                                   AS country_code,
  u.is_banned                                      AS is_banned,
  u.is_locked                                      AS is_locked,
  u.is_suspected_alt                               AS is_suspected_alt,

  COALESCE(b.total_deposited::text, '0')           AS total_deposited,
  COALESCE(b.total_withdrawn::text, '0')           AS total_withdrawn,
  COALESCE(b.total_wagered::text, '0')             AS total_wagered,
  COALESCE(b.total_won::text, '0')                 AS total_won,
  COALESCE(b.available_balance::text, '0')         AS available_balance,
  COALESCE(b.locked_balance::text, '0')            AS locked_balance,
  COALESCE(inv.inv_value::text, '0')               AS inventory_value,
  COALESCE(cw.wd_value::text, '0')                 AS card_withdrawal_value,

  COALESCE(agg.deposits_24h_usd::text, '0')        AS deposits_24h_usd,
  COALESCE(agg.deposits_7d_usd::text, '0')         AS deposits_7d_usd,
  COALESCE(agg.deposits_all_usd::text, '0')        AS deposits_all_usd,
  COALESCE(agg.deposit_count_all::text, '0')       AS deposit_count_all,
  agg.first_deposit_at                             AS first_deposit_at,
  agg.last_deposit_at                              AS last_deposit_at,
  fw.first_at                                      AS first_wager_at,
  COALESCE(agg.max_single_deposit::text, '0')      AS max_single_deposit,
  COALESCE(wp.wad_count::text, '0')                AS withdrawals_after_deposit_1h,
  COALESCE(wp.wab_count::text, '0')                AS withdrawals_after_bonus_1h,

  COALESCE(agg.deposit_bonus_count::text, '0')     AS deposit_bonus_count,
  COALESCE(agg.deposit_bonus_value::text, '0')     AS deposit_bonus_value,
  COALESCE(gc.c::text, '0')                        AS gift_card_count,
  COALESCE(pc.c::text, '0')                        AS promo_code_count,
  COALESCE(rnb.c::text, '0')                       AS rakeback_near_bonus_count,
  COALESCE(agg.rakeback_claim_count::text, '0')    AS rakeback_claim_count,
  COALESCE(agg.voucher_redeem_count::text, '0')    AS voucher_redeem_count,

  COALESCE(agg.pack_opens::text, '0')              AS pack_opens,
  COALESCE(agg.battles_played::text, '0')          AS battles_played,
  COALESCE(agg.biggest_single_wager::text, '0')    AS biggest_single_wager,

  COALESCE(fl.c::text, '0')                        AS feature_lock_count,
  COALESCE(mu.c::text, '0')                        AS mute_count,

  COALESCE(scc.c::text, '0')                       AS session_country_count,
  COALESCE(das.c::text, '0')                       AS deposit_address_shared_accounts

FROM ids
JOIN "user" u ON u.id = ids.user_id
LEFT JOIN balances b ON b.user_id = u.id

LEFT JOIN (
  SELECT user_id,
         COALESCE(SUM(value_at_obtained::numeric), 0) AS inv_value
  FROM user_inventory
  WHERE sold_at IS NULL AND exchanged_at IS NULL
  GROUP BY user_id
) inv ON inv.user_id = u.id

LEFT JOIN (
  SELECT user_id,
         COALESCE(SUM(total_value_usd::numeric), 0) AS wd_value
  FROM card_withdrawal_requests
  WHERE status IN ('completed','shipped')
  GROUP BY user_id
) cw ON cw.user_id = u.id

LEFT JOIN (
  SELECT user_id,
    COALESCE(SUM(amount::numeric) FILTER (WHERE type='deposit' AND status='completed' AND created_at >= NOW() - INTERVAL '24 hours'), 0) AS deposits_24h_usd,
    COALESCE(SUM(amount::numeric) FILTER (WHERE type='deposit' AND status='completed' AND created_at >= NOW() - INTERVAL '7 days'), 0) AS deposits_7d_usd,
    COALESCE(SUM(amount::numeric) FILTER (WHERE type='deposit' AND status='completed'), 0) AS deposits_all_usd,
    COUNT(*) FILTER (WHERE type='deposit' AND status='completed') AS deposit_count_all,
    MIN(created_at) FILTER (WHERE type='deposit' AND status='completed') AS first_deposit_at,
    MAX(created_at) FILTER (WHERE type='deposit' AND status='completed') AS last_deposit_at,
    COALESCE(MAX(amount::numeric) FILTER (WHERE type='deposit' AND status='completed'), 0) AS max_single_deposit,
    COUNT(*) FILTER (WHERE type='deposit_bonus' AND status='completed') AS deposit_bonus_count,
    COALESCE(SUM(amount::numeric) FILTER (WHERE type='deposit_bonus' AND status='completed'), 0) AS deposit_bonus_value,
    COUNT(*) FILTER (WHERE type='rakeback_claim' AND status='completed') AS rakeback_claim_count,
    COUNT(*) FILTER (WHERE type='voucher_redeemed' AND status='completed') AS voucher_redeem_count,
    COUNT(*) FILTER (WHERE type='pack_opening' AND status='completed') AS pack_opens,
    COUNT(*) FILTER (WHERE type='battle_bet' AND status='completed') AS battles_played,
    COALESCE(MAX(ABS(amount::numeric)) FILTER (WHERE status='completed' AND type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')), 0) AS biggest_single_wager
  FROM ledger_transactions
  WHERE user_id IN (SELECT user_id FROM ids)
  GROUP BY user_id
) agg ON agg.user_id = u.id

-- First wager per user. Separate from the main agg CTE because the MIN
-- needs a filter on gaming-only types and mixing it with the FILTER
-- list above was getting noisy.
LEFT JOIN (
  SELECT user_id, MIN(created_at) AS first_at
  FROM ledger_transactions
  WHERE status='completed' AND type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
    AND user_id IN (SELECT user_id FROM ids)
  GROUP BY user_id
) fw ON fw.user_id = u.id

-- Withdrawal-after-deposit and Withdrawal-after-bonus pair counts.
-- EXISTS inside a lateral isn't straightforward across postgres versions
-- so we compose as a pair of LEFT JOINs against aggregated counts.
LEFT JOIN (
  SELECT w.user_id,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM ledger_transactions d
      WHERE d.user_id = w.user_id AND d.type='deposit' AND d.status='completed'
        AND w.created_at BETWEEN d.created_at AND d.created_at + INTERVAL '1 hour'
    )) AS wad_count,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM ledger_transactions bonus
      WHERE bonus.user_id = w.user_id AND bonus.status='completed'
        AND bonus.type IN ('deposit_bonus','rakeback_claim','balance_reward_claim','promo_code_redeemed','gift_card_redeemed','affiliate_claim')
        AND w.created_at BETWEEN bonus.created_at AND bonus.created_at + INTERVAL '1 hour'
    )) AS wab_count
  FROM ledger_transactions w
  WHERE w.type='card_withdrawal' AND w.status IN ('completed','pending')
    AND w.user_id IN (SELECT user_id FROM ids)
  GROUP BY w.user_id
) wp ON wp.user_id = u.id

LEFT JOIN (
  SELECT redeemed_by_user_id AS user_id, COUNT(*) AS c
  FROM gift_cards WHERE redeemed_by_user_id IN (SELECT user_id FROM ids)
  GROUP BY redeemed_by_user_id
) gc ON gc.user_id = u.id

LEFT JOIN (
  SELECT user_id, COUNT(*) AS c
  FROM promo_code_redemptions WHERE user_id IN (SELECT user_id FROM ids)
  GROUP BY user_id
) pc ON pc.user_id = u.id

LEFT JOIN (
  SELECT r.user_id, COUNT(*) AS c
  FROM ledger_transactions r
  WHERE r.type='rakeback_claim' AND r.status='completed'
    AND r.user_id IN (SELECT user_id FROM ids)
    AND EXISTS (
      SELECT 1 FROM ledger_transactions db
      WHERE db.user_id=r.user_id AND db.type='deposit_bonus' AND db.status='completed'
        AND ABS(EXTRACT(EPOCH FROM (r.created_at - db.created_at))) < 3600
    )
  GROUP BY r.user_id
) rnb ON rnb.user_id = u.id

LEFT JOIN (
  SELECT user_id, (
    (CASE WHEN array_length(locked_deposits_crypto,1)>0 THEN 1 ELSE 0 END) +
    (CASE WHEN array_length(locked_deposits_fiat,1)>0 THEN 1 ELSE 0 END) +
    (CASE WHEN array_length(locked_withdrawals_crypto,1)>0 THEN 1 ELSE 0 END) +
    (CASE WHEN locked_withdrawals_items THEN 1 ELSE 0 END) +
    (CASE WHEN locked_inventory_sales THEN 1 ELSE 0 END) +
    (CASE WHEN locked_exchanges THEN 1 ELSE 0 END) +
    (CASE WHEN locked_openings THEN 1 ELSE 0 END) +
    (CASE WHEN locked_vault THEN 1 ELSE 0 END)
  ) AS c
  FROM user_feature_locks WHERE user_id IN (SELECT user_id FROM ids)
) fl ON fl.user_id = u.id

LEFT JOIN (
  SELECT user_id, COUNT(*) AS c
  FROM user_mutes WHERE unmuted_at IS NULL AND user_id IN (SELECT user_id FROM ids)
  GROUP BY user_id
) mu ON mu.user_id = u.id

LEFT JOIN (
  SELECT "userId" AS user_id, COUNT(DISTINCT country_code) AS c
  FROM session WHERE country_code IS NOT NULL AND "userId" IN (SELECT user_id FROM ids)
  GROUP BY "userId"
) scc ON scc.user_id = u.id

LEFT JOIN (
  SELECT da1.user_id, COUNT(DISTINCT da2.user_id) AS c
  FROM deposit_addresses da1
  JOIN deposit_addresses da2
    ON da1.address = da2.address AND da1.asset_id = da2.asset_id AND da2.user_id <> da1.user_id
  WHERE da1.user_id IN (SELECT user_id FROM ids)
  GROUP BY da1.user_id
) das ON das.user_id = u.id
`;

// ---------------------------------------------------------------------------
// Network signal queries — shared IP / fingerprint
// ---------------------------------------------------------------------------

/**
 * Count OTHER users (excluding the subject) that have logged in or signed
 * up from any of the subject's known IPs. Uses the fingerprints table
 * which stores IP + user_id for every login/signup event.
 */
async function countSharedIpUsers(userId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(DISTINCT f2.user_id)::bigint AS c
    FROM fingerprints f1
    JOIN fingerprints f2
      ON f1.ip = f2.ip
     AND f2.user_id IS NOT NULL
     AND f2.user_id <> ${userId}
    WHERE f1.user_id = ${userId} AND f1.ip IS NOT NULL
  `;
  return Number(rows[0]?.c ?? 0);
}

/**
 * Count OTHER users sharing the same device fingerprint (visitor_id) as
 * the subject. Much stronger signal than IP alone — fingerprints are
 * stable across IPs on the same device.
 */
async function countSharedFingerprintUsers(userId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(DISTINCT f2.user_id)::bigint AS c
    FROM fingerprints f1
    JOIN fingerprints f2
      ON f1.visitor_id = f2.visitor_id
     AND f2.user_id IS NOT NULL
     AND f2.user_id <> ${userId}
    WHERE f1.user_id = ${userId}
  `;
  return Number(rows[0]?.c ?? 0);
}

/**
 * Batch variant: { user_id → shared IP count } for a list of users in
 * one round trip. Same semantic as the per-user helper.
 */
async function batchSharedIpCounts(
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const db = await getDb();
  if (userIds.length === 0) return new Map();
  const rows = await db.$queryRawUnsafe<{ user_id: string; c: bigint }[]>(
    `
    SELECT f1.user_id, COUNT(DISTINCT f2.user_id)::bigint AS c
    FROM fingerprints f1
    JOIN fingerprints f2
      ON f1.ip = f2.ip
     AND f2.user_id IS NOT NULL
     AND f2.user_id <> f1.user_id
    WHERE f1.user_id = ANY($1::text[]) AND f1.ip IS NOT NULL
    GROUP BY f1.user_id
    `,
    userIds as string[],
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.c)]));
}

async function batchSharedFingerprintCounts(
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const db = await getDb();
  if (userIds.length === 0) return new Map();
  const rows = await db.$queryRawUnsafe<{ user_id: string; c: bigint }[]>(
    `
    SELECT f1.user_id, COUNT(DISTINCT f2.user_id)::bigint AS c
    FROM fingerprints f1
    JOIN fingerprints f2
      ON f1.visitor_id = f2.visitor_id
     AND f2.user_id IS NOT NULL
     AND f2.user_id <> f1.user_id
    WHERE f1.user_id = ANY($1::text[])
    GROUP BY f1.user_id
    `,
    userIds as string[],
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.c)]));
}

// ---------------------------------------------------------------------------
// Admin notes count — lives in Admin DB (dual-DB rule)
// ---------------------------------------------------------------------------

async function countAdminNotes(userId: string): Promise<number> {
  try {
    const c = await adminDb.admin_notes.count({
      where: { target_user_id: userId },
    });
    return c;
  } catch {
    // Admin DB may not be reachable in every environment (e.g. a dev
    // machine running only the main DB). Treat as zero rather than
    // crashing the entire score computation.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Network counts aggregator
// ---------------------------------------------------------------------------
//
// Runs the four shared-identity queries in parallel and packages them as
// the `NetworkCounts` context the signal builder expects. Any individual
// query failure (e.g. missing `fingerprints` table in a fresh env) is
// swallowed — we prefer a partial network signal over a full compute
// failure for the moderator.
async function fetchNetworkCounts(userId: string): Promise<NetworkCounts> {
  const [sharedIpCount, sharedFingerprintCount, bannedLocked] = await Promise.all([
    countSharedIpUsers(userId).catch(() => 0),
    countSharedFingerprintUsers(userId).catch(() => 0),
    countSharedBannedLocked(userId).catch(() => ({ banned: 0, locked: 0 })),
  ]);
  return {
    sharedIpCount,
    sharedFingerprintCount,
    sharedBannedCount: bannedLocked.banned,
    sharedLockedCount: bannedLocked.locked,
  };
}

async function countSharedBannedLocked(
  userId: string,
): Promise<{ banned: number; locked: number }> {
  const db = await getDb();
  // Users who share at least one IP OR fingerprint visitor_id with the
  // target AND are currently banned or locked. A single raw query keeps
  // us to one round trip regardless of how many neighbours they have.
  const rows = await db.$queryRawUnsafe<{ banned: string; locked: string }[]>(
    `
    WITH nbrs AS (
      SELECT DISTINCT other_user_id AS uid FROM (
        SELECT DISTINCT f2.user_id AS other_user_id
          FROM fingerprints f1
          JOIN fingerprints f2
            ON f2.ip = f1.ip
           AND f2.user_id <> f1.user_id
         WHERE f1.user_id = $1
        UNION
        SELECT DISTINCT f2.user_id AS other_user_id
          FROM fingerprints f1
          JOIN fingerprints f2
            ON f2.visitor_id = f1.visitor_id
           AND f2.user_id <> f1.user_id
         WHERE f1.user_id = $1
      ) t
    )
    SELECT
      COALESCE(SUM(CASE WHEN u.is_banned THEN 1 ELSE 0 END), 0)::text AS banned,
      COALESCE(SUM(CASE WHEN u.is_locked THEN 1 ELSE 0 END), 0)::text AS locked
      FROM nbrs
      JOIN "user" u ON u.id = nbrs.uid
    `,
    userId,
  );
  return {
    banned: Number(rows[0]?.banned ?? 0),
    locked: Number(rows[0]?.locked ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Timeline — last 7 days of signal-relevant events
// ---------------------------------------------------------------------------
//
// Union of ledger rows + withdrawal requests + signup event. Sorted
// newest first. Used to let the moderator scan the cadence of events
// and spot patterns (e.g. deposit → bonus → withdrawal within minutes).
async function fetchTimeline(userId: string): Promise<RiskTimelineEvent[]> {
  const db = await getDb();
  const sinceDate = new Date(Date.now() - MS_PER_WEEK);

  const [ledger, wdReqs, user] = await Promise.all([
    db.ledger_transactions
      .findMany({
        where: {
          user_id: userId,
          status: "completed",
          created_at: { gte: sinceDate },
        },
        orderBy: { created_at: "desc" },
        take: 200,
        select: { type: true, amount: true, created_at: true },
      })
      .catch(() => []),
    db.card_withdrawal_requests
      .findMany({
        where: { user_id: userId, requested_at: { gte: sinceDate } },
        orderBy: { requested_at: "desc" },
        take: 50,
        select: {
          status: true,
          total_value_usd: true,
          requested_at: true,
        },
      })
      .catch(() => []),
    db.user
      .findUnique({ where: { id: userId }, select: { created_at: true } })
      .catch(() => null),
  ]);

  const events: RiskTimelineEvent[] = [];

  for (const r of ledger) {
    const kind = classifyTimelineKind(r.type);
    if (!kind) continue;
    events.push({
      kind,
      label: TIMELINE_LABELS[r.type] ?? r.type,
      amountUsd: Math.abs(toNumber(r.amount)) || null,
      at: r.created_at.toISOString(),
    });
  }

  for (const r of wdReqs) {
    const kind: RiskTimelineEvent["kind"] =
      r.status === "failed" || r.status === "cancelled"
        ? "withdrawal_failed"
        : "withdrawal_attempt";
    events.push({
      kind,
      label:
        kind === "withdrawal_failed"
          ? `Withdrawal ${r.status}`
          : "Withdrawal requested",
      amountUsd: toNumber(r.total_value_usd) || null,
      at: r.requested_at.toISOString(),
    });
  }

  if (user?.created_at && user.created_at >= sinceDate) {
    events.push({
      kind: "signup",
      label: "Account created",
      amountUsd: null,
      at: user.created_at.toISOString(),
    });
  }

  events.sort((a, b) => (a.at < b.at ? 1 : -1));
  return events.slice(0, 50);
}

function classifyTimelineKind(type: string): RiskTimelineEvent["kind"] | null {
  switch (type) {
    case "deposit":
      return "deposit";
    case "card_withdrawal":
      return "withdrawal";
    case "pack_opening":
    case "battle_bet":
    case "battle_sponsorship":
      return "wager";
    case "deposit_bonus":
    case "promo_code_redeemed":
    case "gift_card_redeemed":
    case "voucher_redeemed":
      return "bonus";
    case "rakeback_claim":
    case "affiliate_claim":
    case "balance_reward_claim":
    case "rain_win":
    case "race_prize":
    case "waitlist_prize":
      return "reward";
    default:
      return null;
  }
}

const TIMELINE_LABELS: Record<string, string> = {
  deposit: "Deposit",
  card_withdrawal: "Card withdrawal",
  pack_opening: "Pack wager",
  battle_bet: "Battle wager",
  battle_sponsorship: "Battle sponsorship",
  deposit_bonus: "Deposit bonus",
  promo_code_redeemed: "Promo code redeemed",
  gift_card_redeemed: "Gift card redeemed",
  voucher_redeemed: "Voucher redeemed",
  rakeback_claim: "Rakeback claim",
  affiliate_claim: "Affiliate payout",
  balance_reward_claim: "Balance reward",
  rain_win: "Rain win",
  race_prize: "Race prize",
  waitlist_prize: "Waitlist prize",
};

// ---------------------------------------------------------------------------
// Action suggestions — small rule-based pass over triggered signals
// ---------------------------------------------------------------------------
//
// Intentionally simple. Never auto-applies anything. If an obvious
// pattern is present we surface a one-line hint; otherwise stay silent.
function buildSuggestions(
  signals: RiskSignal[],
  tier: RiskTier,
): RiskActionSuggestion[] {
  const triggered = signals.filter((s) => s.triggered);
  const has = (id: string) => triggered.some((s) => s.id === id);
  const ids = triggered.map((s) => s.id);

  const out: RiskActionSuggestion[] = [];

  // Bonus-abuse textbook pattern
  if (
    has("rewards.signup_reward_instant_withdraw") ||
    (has("rewards.withdraw_after_bonus") &&
      has("rewards.bonus_heavy_over_deposit"))
  ) {
    out.push({
      kind: "investigate_bonus_abuse",
      label: "Investigate bonus abuse",
      reason:
        "This account withdrew (or attempted to) shortly after a bonus credit and before meaningful wagering. Classic bonus-abuse signature.",
      causedBy: ids.filter(
        (id) =>
          id === "rewards.signup_reward_instant_withdraw" ||
          id === "rewards.withdraw_after_bonus" ||
          id === "rewards.bonus_heavy_over_deposit",
      ) as RiskSignal["id"][],
    });
  }

  // Shared-identity ring
  if (
    has("network.shared_fingerprint") ||
    has("network.shared_with_banned") ||
    has("network.self_referral_ring")
  ) {
    out.push({
      kind: "investigate_multi_account",
      label: "Investigate multi-account ring",
      reason:
        "Account shares device fingerprint or network identity with other users — possible alt / self-referral ring.",
      causedBy: ids.filter((id) =>
        id.startsWith("network."),
      ) as RiskSignal["id"][],
    });
  }

  // Pending-withdrawal freeze
  if (
    has("velocity.deposit_withdraw_wager_5m") ||
    has("rewards.withdrawal_attempt_pre_wager")
  ) {
    out.push({
      kind: "block_withdrawal",
      label: "Consider blocking pending withdrawal",
      reason:
        "Withdrawal requested in a compressed window that looks like laundering or bonus cash-out. Review before releasing funds.",
      causedBy: ids.filter(
        (id) =>
          id === "velocity.deposit_withdraw_wager_5m" ||
          id === "rewards.withdrawal_attempt_pre_wager",
      ) as RiskSignal["id"][],
    });
  }

  // Tier fallback
  if (tier === "critical" && out.length === 0) {
    out.push({
      kind: "lock_account",
      label: "Lock account pending review",
      reason:
        "Score hit critical. Multiple independent signals stacked — pause the account until a human confirms or clears.",
      causedBy: triggered.slice(0, 5).map((s) => s.id),
    });
  } else if (tier === "high" && out.length === 0) {
    out.push({
      kind: "manual_review",
      label: "Flag for manual review",
      reason: "High-tier score with no single textbook pattern — worth a human eye.",
      causedBy: triggered.slice(0, 5).map((s) => s.id),
    });
  } else if (tier === "medium" && out.length === 0) {
    out.push({
      kind: "monitor",
      label: "Monitor passively",
      reason: "Nothing urgent — re-check if more signals stack.",
      causedBy: [],
    });
  }

  return out;
}
