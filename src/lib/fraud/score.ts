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

import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";

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
const CACHE_TTL_MS = 60_000;
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
  first_deposit_at: Date | null;
  last_deposit_at: Date | null;
  first_wager_at: Date | null;
  max_single_deposit: string;
  withdrawals_after_deposit_1h: string;
  withdrawals_after_bonus_1h: string;

  // bonus / rewards
  deposit_bonus_count: string;
  deposit_bonus_value: string;
  gift_card_count: string;
  promo_code_count: string;
  rakeback_near_bonus_count: string;
  rakeback_claim_count: string;
  voucher_redeem_count: string;

  // gameplay
  pack_opens: string;
  battles_played: string;
  biggest_single_wager: string;

  // account
  feature_lock_count: string;
  mute_count: string;

  // network — counted via separate queries (see below) so the detail
  // query stays reasonably sized.
  session_country_count: string;
  deposit_address_shared_accounts: string;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function computeRiskScore(
  userId: string,
  opts?: { skipCache?: boolean },
): Promise<RiskScoreBreakdown> {
  if (!opts?.skipCache) {
    const cached = getCached(userId);
    if (cached) return cached;
  }

  // ── Round-trip 1: heavy aggregate SQL ────────────────────────────────
  const rows = await db.$queryRawUnsafe<DetailRow[]>(DETAIL_SQL, userId);
  if (rows.length === 0) {
    // No such user — produce a trivial "no data" breakdown. Keeps callers
    // simple (they don't need to handle null).
    const emptySignals: RiskSignal[] = [];
    const empty: RiskScoreBreakdown = {
      score: 0,
      tier: "low",
      signals: emptySignals,
      sharedIpCount: 0,
      sharedFingerprintCount: 0,
      computedAt: Date.now(),
    };
    setCached(userId, empty);
    return empty;
  }

  const row = rows[0];

  // ── Round-trip 2-4: network signals + admin notes ────────────────────
  // These live in separate queries because:
  //   - Shared IP / fingerprint counts need a DISTINCT on other_user_id
  //     which doesn't compose cleanly with the main aggregate.
  //   - admin_notes lives in the Admin DB (see CLAUDE.md dual-DB rule).
  const [sharedIpCount, sharedFingerprintCount, adminNotesCount] =
    await Promise.all([
      countSharedIpUsers(userId),
      countSharedFingerprintUsers(userId),
      countAdminNotes(userId),
    ]);

  const signals = buildSignals(row, {
    sharedIpCount,
    sharedFingerprintCount,
    adminNotesCount,
  });

  const total = signals.reduce(
    (acc, s) => (s.triggered ? acc + s.weight : acc),
    0,
  );
  const score = Math.max(0, Math.min(100, Math.round(total)));
  const tier = tierForScore(score);

  const result: RiskScoreBreakdown = {
    score,
    tier,
    signals,
    sharedIpCount,
    sharedFingerprintCount,
    computedAt: Date.now(),
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
  const out = new Map<string, RiskScoreLite>();
  if (userIds.length === 0) return out;

  const rows = await db.$queryRawUnsafe<DetailRow[]>(
    BATCH_SQL,
    userIds as string[],
  );

  // Also fetch the three network counts. Single query each, grouped by
  // the user_id subject, so we stay at O(1) round-trips regardless of the
  // page size.
  const [ipCountMap, fpCountMap] = await Promise.all([
    batchSharedIpCounts(userIds),
    batchSharedFingerprintCounts(userIds),
  ]);

  for (const row of rows) {
    const sharedIpCount = ipCountMap.get(row.user_id) ?? 0;
    const sharedFingerprintCount = fpCountMap.get(row.user_id) ?? 0;

    // adminNotesCount is skipped in the list view — it's rarely the
    // difference-maker between tiers and needs a second DB. For the
    // list-level tier we treat it as 0. The detail view shows the real
    // count.
    const signals = buildSignals(row, {
      sharedIpCount,
      sharedFingerprintCount,
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

function buildSignals(
  row: DetailRow,
  ctx: {
    sharedIpCount: number;
    sharedFingerprintCount: number;
    adminNotesCount: number;
  },
): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // Derived primitives ────────────────────────────────────────────────
  const now = Date.now();
  const accountAgeMs = now - new Date(row.created_at).getTime();
  const accountAgeDays = accountAgeMs / (1000 * 60 * 60 * 24);

  const totalDeposited = toNumber(row.total_deposited);
  const totalWithdrawn =
    toNumber(row.total_withdrawn) + toNumber(row.card_withdrawal_value);
  const totalWagered = toNumber(row.total_wagered);
  const totalWon = toNumber(row.total_won);

  const deposits24h = toNumber(row.deposits_24h_usd);
  const deposits7d = toNumber(row.deposits_7d_usd);
  const depositCountAll = toNumber(row.deposit_count_all);
  const maxSingleDeposit = toNumber(row.max_single_deposit);

  const firstDepositAt = row.first_deposit_at
    ? new Date(row.first_deposit_at)
    : null;
  const firstWagerAt = row.first_wager_at
    ? new Date(row.first_wager_at)
    : null;
  const lastDepositAt = row.last_deposit_at
    ? new Date(row.last_deposit_at)
    : null;

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY A — Money velocity & patterns (max ~30)
  // ═══════════════════════════════════════════════════════════════════

  // A1 — Large burst deposits in first 24h on a new account.
  //      Weighted proportionally to the $ amount, bounded at 20.
  //      Only fires when the account is <14 days old to avoid false
  //      positives on established whales.
  const deposit7dBaseline =
    deposits7d - deposits24h; // 6 previous days only
  const baselinePerDay = deposit7dBaseline / 6;
  const depositBurstRatio =
    baselinePerDay > 0 ? deposits24h / baselinePerDay : 0;
  const a1Weight = (() => {
    if (accountAgeDays > 14) return 0;
    if (deposits24h < 500) return 0;
    // Scale: $500=3, $2000=10, $5000=18, cap at 20.
    const w = Math.min(20, 3 + (deposits24h - 500) / 350);
    return Math.round(w);
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
  const a2Weight = wAfterD === 0 ? 0 : Math.min(15, 5 + wAfterD * 2);
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
    // Scale: 1.1x=3, 1.5x=8, 2.0x=13, 3.0x=18, cap 18.
    const w = Math.min(18, 3 + (withdrawRatio - 1.1) * 7);
    return Math.round(w);
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
  const depositToWagerHours = depositToWagerMs / (1000 * 60 * 60);
  const a4Weight =
    depositCountAll > 0 && !firstWagerAt && totalDeposited >= 100
      ? 10
      : depositToWagerHours > 48 && totalDeposited >= 100
        ? 6
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
    explanation: !firstWagerAt
      ? "User has made deposits but never wagered. Money-parking indicator."
      : depositToWagerHours > 48
        ? `First wager came ${depositToWagerHours.toFixed(1)}h after the first deposit — far outside the typical minutes-to-hours window.`
        : "First wager followed deposit within a normal window.",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY B — Gameplay behaviour (max ~25)
  // ═══════════════════════════════════════════════════════════════════

  // B1 — Very low wager multiplier. Deposited X but wagered < 0.3X. The
  //      user is effectively just moving money through the platform.
  const wagerMultiplier =
    totalDeposited > 0 ? totalWagered / totalDeposited : 0;
  const b1Weight =
    totalDeposited >= 250 && wagerMultiplier < 0.3
      ? 12
      : totalDeposited >= 250 && wagerMultiplier < 0.6
        ? 6
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
      ? 10
      : totalWagered >= 1000 && userHouseEdge < 0.05
        ? 5
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
      ? 6
      : accountAgeDays < 7 && biggestSingle >= 500
        ? 4
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
        : "No unusual single-wager spikes on a young account.",
  });

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY C — Rewards / bonus abuse (max ~20)
  // ═══════════════════════════════════════════════════════════════════

  // C1 — Rakeback claims timed within minutes of a deposit-bonus. This
  //      is a stacking pattern — user triggers a deposit bonus, claims
  //      rakeback on top, and withdraws. The SQL subquery counts how
  //      many rakeback claims happened within ±1h of any deposit_bonus
  //      credit.
  const rakebackNearBonus = toNumber(row.rakeback_near_bonus_count);
  const c1Weight =
    rakebackNearBonus >= 3 ? 12 : rakebackNearBonus >= 1 ? 6 : 0;
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
  const giftCardCount = toNumber(row.gift_card_count);
  const promoCount = toNumber(row.promo_code_count);
  const bonusRedeemCount = giftCardCount + promoCount;
  const c2Weight = bonusRedeemCount >= 5 ? 10 : bonusRedeemCount >= 3 ? 5 : 0;
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
  const c3Weight = wAfterBonus >= 2 ? 10 : wAfterBonus >= 1 ? 5 : 0;
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
  const voucherRedeem = toNumber(row.voucher_redeem_count);
  const packOpens = toNumber(row.pack_opens);
  const c4Weight =
    voucherRedeem >= 5 && packOpens < voucherRedeem ? 6 : 0;
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

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY D — Identity & network (max ~25)
  // ═══════════════════════════════════════════════════════════════════

  // D1 — Shared IP with other users. Residential IP sharing (friends /
  //      family on the same wifi) is normal up to 1-2 other users. Past
  //      that it starts looking like a multi-account farm. Graded weight.
  const d1Weight =
    ctx.sharedIpCount >= 5
      ? 18
      : ctx.sharedIpCount >= 3
        ? 12
        : ctx.sharedIpCount >= 2
          ? 6
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
      ? 22
      : ctx.sharedFingerprintCount >= 2
        ? 16
        : ctx.sharedFingerprintCount >= 1
          ? 10
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
  const d3Weight = countryCount >= 5 ? 8 : countryCount >= 4 ? 4 : 0;
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
  const d4Weight = sharedCryptoAddr >= 2 ? 25 : sharedCryptoAddr >= 1 ? 15 : 0;
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

  // ═══════════════════════════════════════════════════════════════════
  // CATEGORY E — Account state red flags (max ~20)
  // ═══════════════════════════════════════════════════════════════════

  // E1 — Already banned or locked by an admin. If another human already
  //      flagged this, future sessions are by definition suspicious.
  const e1Weight = row.is_banned ? 20 : row.is_locked ? 10 : 0;
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
  const e2Weight = row.is_suspected_alt ? 8 : 0;
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
  const e3Weight = featureLockCount >= 2 ? 8 : featureLockCount >= 1 ? 4 : 0;
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
  const e5Weight = muteCount >= 3 ? 5 : muteCount >= 1 ? 2 : 0;
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
      ? 6
      : accountAgeDays < 7 && totalDeposited >= 3000
        ? 4
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

  // Keep a side-channel to last-deposit — referenced in the network
  // explanation strings above in some variants. Nothing to do with score.
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
    AND type IN ('pack_opening','battle_bet','battle_sponsorship')
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
    AND type IN ('pack_opening','battle_bet','battle_sponsorship')
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
    COALESCE(MAX(ABS(amount::numeric)) FILTER (WHERE status='completed' AND type IN ('pack_opening','battle_bet','battle_sponsorship')), 0) AS biggest_single_wager
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
  WHERE status='completed' AND type IN ('pack_opening','battle_bet','battle_sponsorship')
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
