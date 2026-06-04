import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getMetricsScope } from "@/lib/metrics/scope";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import { realCustomersScopeSql } from "@/lib/queries/insights-games/_shared";
import { countedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";

/**
 * "Reward Costs (today)" dashboard box — what the house spent on REWARDS
 * for the CURRENT CALENDAR DAY since 00:00 (NOT a rolling past-24h
 * window). Same UTC-midnight boundary as the P&L Today tile
 * (`dashboard-today-pnl.ts` `utcStartOfDay`), so the two reconcile on
 * "today".
 *
 * ─── It REUSES the canonical reward-cost definitions, not new math ──────
 *
 * The per-line cost definitions mirror EXACTLY what the canonical reward
 * cost (`src/lib/metrics/queries.ts` `getRewardCost`) and the insights
 * surfaces count, just scoped to [today 00:00 UTC, now):
 *
 *   • Ledger reward types — `REWARD_PAYOUT_TYPES` from
 *     `@/lib/metrics/ledger-sets.ts`, the single source of truth for what
 *     counts as a house-funded reward cost. Summed `ABS(amount)` over the
 *     SAME canonical metric scope (`getMetricsScope`: staff + blacklist
 *     dropped, creators dropped wholesale, creator-on-session rows
 *     excluded) — identical to `getRewardCost`.
 *   • The two per-row carve-outs `getRewardCost` applies are applied here
 *     too, broken out as their own lines:
 *       – manual house-granted vouchers (`voucher_redeemed` where
 *         `metadata->>'origin' = 'manual'`), and
 *       – counted `admin_balance_adjustment` credits (giveaway / bonus /
 *         reload / lossback / deposit-fix), via the canonical
 *         `countedAdjustmentSqlPredicate`.
 *   • Daily / free packs (`packs.pack_type = 'reward'`) — the zero-price
 *     giveaway of real cards that books NO ledger row, so the ledger sweep
 *     above under-counts it. Cost = value of cards handed out today
 *     (`Σ user_inventory.value_at_obtained`), exactly as
 *     `insights-rewards/daily-packs.ts` `getDailyPacksTotalCost` defines
 *     it (cards out, NOT net of the ≈$0 wager — that wager lives on the
 *     GGR side via `pack_opening`).
 *
 * ─── Three deliberate departures from `getRewardCost` ───────────────────
 *
 *   • RAIN is NOT the summed `rain_win` magnitude. Per the owner, rain
 *     costs the house a FLAT $2 per hour ("we don't pay anything else for
 *     it"), so the rain line today = `2 × hoursElapsedSinceUtcMidnight`.
 *     `rain_win` / `rain_tip` are NOT summed at all here. The elapsed-hours
 *     figure is computed from a `now` timestamp passed IN by the server
 *     component (never `Date.now()` inside the cached function, which would
 *     freeze at fill time).
 *   • AFFILIATE COSTS are EXCLUDED entirely. `affiliate_claim` (affiliate
 *     commissions) is in `REWARD_PAYOUT_TYPES` but is deliberately dropped
 *     from this box's total — this box is reward/retention spend, not
 *     affiliate program cost.
 *   • LEADERBOARD prizes are EXCLUDED entirely (owner decision, 2026-06-04).
 *     Every `affiliate_leaderboard_prize` is a CREATOR-run leaderboard
 *     payout (see `creators-leaderboards.ts`: "affiliate leaderboards are
 *     creator-run events"), so its FULL gross is a CREATOR cost counted
 *     wholly in the dashboard "Creators Costs" box — $0 of it lands here.
 *     This box no longer carries any leaderboard line, and the old
 *     sponsored-% on-site split that used to charge the remainder to the
 *     house here is gone. The two boxes therefore never double-count: Reward
 *     Costs counts $0 leaderboard, Creators Costs counts the full gross. The
 *     per-claimant drilldown that used to live on this box's leaderboard
 *     line now lives on the Creators Costs box (showing full gross).
 *
 * House-POV per CLAUDE.md: every line is money the house PAID OUT to users
 * → a house cost → rose in the UI. Read-only against the Main DB.
 *
 * ─── PERFORMANCE ────────────────────────────────────────────────────────
 *
 * `unstable_cache` keyed on the UTC day string + the serialized blacklist
 * (revalidate 60s), wrapped in `safeQuery` at the call site, streamed in
 * its own `<Suspense>`. Today-only window — no lifetime scan. Two parallel
 * reads (one ledger aggregate, one reward-pack inventory aggregate), both
 * bounded to `created_at`/`obtained_at >= today-00:00`.
 */

/** One reward-cost line on the box. */
export type RewardCostLine = {
  /** Stable key for React. */
  key: string;
  /** Operator-friendly label. */
  label: string;
  /** Absolute dollar magnitude (house cost, always >= 0). */
  amount: number;
};

export type RewardCostsToday = {
  /** Total reward cost today (sum of every line below). */
  total: number;
  /** Itemized lines, largest magnitude first. */
  lines: RewardCostLine[];
  /** ISO timestamp of the window start (today 00:00 UTC). */
  dayStartIso: string;
  /** Hours elapsed since UTC midnight (fractional) — drives the rain line. */
  hoursElapsed: number;
  /** The flat rain cost = $2 × hoursElapsed. */
  rainCost: number;
};

/** Flat rain cost rate, owner-confirmed: $2 per hour, nothing else. */
const RAIN_USD_PER_HOUR = 2;

/**
 * Which canonical `REWARD_PAYOUT_TYPES` members each ledger line below
 * covers — documented here for auditability against the partition in
 * `@/lib/metrics/ledger-sets.ts`. The per-category `CASE` sums in the SQL
 * spell these out one-for-one:
 *
 *   deposit_bonus            → deposit_bonus
 *   rakeback                 → rakeback_claim
 *   promo_gift               → gift_card_redeemed, promo_code_redeemed
 *   race                     → race_prize
 *   signup_balance           → balance_reward_claim, waitlist_prize
 *   manual_voucher           → voucher_redeemed (origin='manual' carve-out)
 *   counted_adjustments      → admin_balance_adjustment (counted credits)
 *
 * DELIBERATELY NOT covered (per the task):
 *   affiliate_claim          → affiliate commissions, EXCLUDED from this box
 *   affiliate_leaderboard_prize → creator-run leaderboard payout, counted
 *                              wholly (full gross) in the Creators Costs box,
 *                              EXCLUDED from this box (owner, 2026-06-04)
 *   rain_win / rain_tip      → replaced by the flat $2/hr rain model
 *
 * If a future migration adds a REWARD_PAYOUT_TYPES member, it will not
 * appear here until a line is added for it — a deliberate, visible gap
 * rather than a silent miscount.
 */

/**
 * Cached inner computation. Keyed on the UTC day string + the serialized
 * blacklist so it re-fills when the day rolls over OR when an admin edits
 * the excluded-users list. `revalidate: 60` matches the dashboard's
 * activity-cache cadence. `getMetricsScope` resolves the blacklist itself
 * (React-cached); the `blacklistKey` arg only participates in the cache
 * key so an admin edit busts it on the next tick (mirrors the established
 * insights-rewards cache wrappers).
 *
 * `hoursElapsed` / `rainCost` are NOT computed here — they depend on the
 * live `now`, which must come from the server component (computing it
 * inside the cache scope would freeze it at fill time). The cached value
 * is only the today-windowed DB aggregate; rain is added at the wrapper.
 */
const cachedLedgerAndPacks = unstable_cache(
  async (
    dayKey: string,
    sinceIso: string,
    blacklistKey: string,
  ): Promise<{ lines: RewardCostLine[] }> => {
    void dayKey; // part of the cache key only
    void blacklistKey; // part of the cache key only (scope re-resolves it)
    return withTiming("dashboard.rewardCostsToday", async () => {
      const db = await getDb();
      const since = `'${sinceIso}'::timestamptz`;

      // ── Ledger reward legs (today) ───────────────────────────────────
      // SAME canonical scope + SAME carve-outs as getRewardCost, broken
      // out per operator-friendly category. affiliate_claim is NOT in any
      // bucket here (excluded); rain_win/rain_tip are NOT summed (flat
      // $2/h model handled at the wrapper).
      const scope = await getMetricsScope();
      const countedAdj = countedAdjustmentSqlPredicate();

      type LedgerRow = {
        deposit_bonus: string;
        rakeback: string;
        promo_gift: string;
        race: string;
        signup_balance: string;
        manual_voucher: string;
        counted_adjustments: string;
      };
      const ledgerRows = await db.$queryRawUnsafe<LedgerRow[]>(
        `WITH ${scope.sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text = 'deposit_bonus' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS deposit_bonus,
           COALESCE(SUM(CASE WHEN type::text = 'rakeback_claim' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rakeback,
           COALESCE(SUM(CASE WHEN type::text IN ('gift_card_redeemed','promo_code_redeemed') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS promo_gift,
           COALESCE(SUM(CASE WHEN type::text = 'race_prize' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS race,
           COALESCE(SUM(CASE WHEN type::text IN ('balance_reward_claim','waitlist_prize') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS signup_balance,
           COALESCE(SUM(CASE WHEN type::text = 'voucher_redeemed' AND metadata->>'origin' = 'manual' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS manual_voucher,
           COALESCE(SUM(CASE WHEN (${countedAdj}) THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS counted_adjustments
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "created_at")}
           AND created_at >= ${since}`,
      );
      const lr = ledgerRows[0];

      // NOTE: affiliate_leaderboard_prize is NOT read here. Every leaderboard
      // prize is a creator-run-event cost counted in FULL (gross) by the
      // Creators Costs box (owner decision, 2026-06-04). This box charges $0
      // of it to the house — there is no leaderboard line on this box.

      // ── Daily / free pack giveaway (today) ───────────────────────────
      // Reward packs (packs.pack_type='reward') book no ledger row — the
      // cost is the value of cards handed out today. Mirrors
      // insights-rewards/daily-packs.ts (join cards through the
      // originating session id so both source_type='pack' and 'reward'
      // rows are captured; realCustomersScopeSql + the not-on-stream
      // guard), but scoped on obtained_at >= today-00:00 instead of the
      // rolling NOW()-INTERVAL window.
      const packScope = await realCustomersScopeSql();
      const sessionWindowsCte = await getCreatorSessionWindowsCte();
      type PackRow = { giveaway_payout: string };
      const packRows = await db.$queryRawUnsafe<PackRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text AS giveaway_payout
         FROM user_inventory ui
         JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
         JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
         WHERE ui.user_id IN ${packScope}
           AND ui.obtained_at >= ${since}
           AND NOT EXISTS (
             SELECT 1 FROM session_windows sw
             WHERE sw.uid = ui.user_id
               AND ui.obtained_at >= sw.win_start
               AND ui.obtained_at <  sw.win_end
           )`,
      );
      const dailyPacks = toNumber(packRows[0]?.giveaway_payout);

      // Build the lines (rain is added at the wrapper). Keep every line —
      // even $0 ones — so the breakdown popover always shows the full
      // roster; the box filters to non-zero for the compact face.
      const lines: RewardCostLine[] = [
        {
          key: "deposit_bonus",
          label: "Deposit bonuses",
          amount: toNumber(lr?.deposit_bonus),
        },
        {
          key: "daily_packs",
          label: "Daily / free packs",
          amount: dailyPacks,
        },
        {
          key: "signup_balance",
          label: "Signup / balance rewards",
          amount: toNumber(lr?.signup_balance),
        },
        {
          key: "rakeback",
          label: "Rakeback claims",
          amount: toNumber(lr?.rakeback),
        },
        {
          key: "promo_gift",
          label: "Promo / gift cards",
          amount: toNumber(lr?.promo_gift),
        },
        {
          key: "race",
          label: "Race / raffle prizes",
          amount: toNumber(lr?.race),
        },
        {
          key: "manual_voucher",
          label: "Manual vouchers",
          amount: toNumber(lr?.manual_voucher),
        },
        {
          key: "counted_adjustments",
          label: "Promo balance credits",
          amount: toNumber(lr?.counted_adjustments),
        },
      ];

      return { lines };
    });
  },
  ["dashboard-reward-costs-today-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * UTC start-of-day for the instant `now`. Mirrors the P&L Today box's
 * boundary (`dashboard-today-pnl.ts`) so the two agree on "today".
 */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Reward costs for the current calendar day (since 00:00 UTC). Resolves
 * the cached today-windowed DB aggregate, then adds the flat rain line
 * ($2 × hours elapsed since UTC midnight) computed from the LIVE `now`
 * (not from inside the cache scope, which would freeze the hours at fill
 * time). Returns the full line roster + total.
 *
 * `void blacklistKey` note: `getMetricsScope` / `realCustomersScopeSql`
 * resolve the blacklist themselves; the sorted signature is threaded only
 * through the cache key so an admin edit to the excluded-users list busts
 * the cache on the next tick — same pattern as the insights-rewards
 * helpers.
 */
export async function getRewardCostsToday(): Promise<RewardCostsToday> {
  return withTiming("dashboard.rewardCostsToday.entry", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    // YYYY-MM-DD in UTC — stable cache key for "today" that rolls at 00:00.
    const dayKey = sinceIso.slice(0, 10);

    // Hours elapsed since UTC midnight (fractional). Bounded to [0, 24] —
    // a clock skew can't push the rain line past a full day's $48.
    const hoursElapsed = Math.min(
      24,
      Math.max(0, (now.getTime() - since.getTime()) / 3_600_000),
    );
    const rainCost = RAIN_USD_PER_HOUR * hoursElapsed;

    // Resolve the blacklist signature for the cache key. getMetricsScope
    // caches getExcludedUserIds, so this is the same React-cached read.
    const blacklist = await getExcludedUserIds();
    const blacklistKey = [...blacklist].sort().join(",");

    const { lines: ledgerLines } = await cachedLedgerAndPacks(
      dayKey,
      sinceIso,
      blacklistKey,
    );

    const lines: RewardCostLine[] = [
      ...ledgerLines,
      { key: "rain", label: "Rain (@ $2/hr)", amount: rainCost },
    ].sort((a, b) => b.amount - a.amount);

    const total = lines.reduce((sum, l) => sum + l.amount, 0);

    return {
      total,
      lines,
      dayStartIso: sinceIso,
      hoursElapsed,
      rainCost,
    };
  });
}
