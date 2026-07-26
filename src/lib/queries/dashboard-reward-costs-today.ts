import "server-only";

import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getMetricsScope } from "@/lib/metrics/scope";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import { realCustomersScopeSql } from "@/lib/queries/insights-games/_shared";
import {
  countedAdjustmentSqlPredicate,
  BALANCE_ADJUSTMENT_CATEGORY_META,
  isBalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";

/** Lowercased username of the founder giveaway account (mirror motha/overview.ts). */
const MOTHA_USERNAME = "motha";

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
 * ─── Deliberate departures from `getRewardCost` ────────────────────────
 *
 *   • RAIN is NOT the summed `rain_win` magnitude. Per the owner, rain
 *     costs the house a FLAT $2 per hour ("we don't pay anything else for
 *     it"), so the rain line today = `2 × hoursElapsedSinceUtcMidnight`.
 *     `rain_win` / `rain_tip` are NOT summed at all here. The elapsed-hours
 *     figure is computed from a `now` timestamp passed IN by the server
 *     component (never `Date.now()` inside the cached function, which would
 *     freeze at fill time).
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
 * ─── Extra lines surfaced beyond the canonical reward cost ──────────────
 *
 * The breakdown adds three named lines that the canonical `getRewardCost`
 * does NOT include — they each model a real retention/giveaway cost the
 * operator wants to see broken out per program (rather than lumped or
 * hidden):
 *
 *   • RAFFLES — today-window RECONSTRUCTED raffle prize cost. Raffles pay
 *     pack/card items via a `prizes` JSON (NOT a ledger money leg), so the
 *     cost is reconstructed by valuing each completed-today raffle's prizes
 *     at the live pack/card price (same method as
 *     `getRaffleForecastBaseline`, scoped to today). Distinct from the
 *     RACES line — `race_prize` (cash race payouts) and raffle prizes
 *     never overlap.
 *   • MOTHA — the founder giveaway account's today outflows across the
 *     three channels modeled by `insights-rewards/motha/overview.ts`:
 *     `creator_tip` + `battle_sponsorship` debited TO motha (motha funding
 *     a tip / sponsoring a battle) + `rain_tips` funded by motha. These
 *     are canonically RESIDUAL / WAGER / rain-funding rows (so they are
 *     NOT in `getRewardCost`), but they ARE money the founder gave away
 *     today, so the operator dashboard surfaces them as their own line.
 *     No double-count: every motha row is from one of those three sources,
 *     none of which lands in any other line on this card.
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
 *   race                     → race_prize (on-site competitive races —
 *                              renamed "Race wins" so the raffles line
 *                              below cannot be confused with it)
 *   signup_balance           → balance_reward_claim, waitlist_prize
 *   manual_voucher           → voucher_redeemed (origin='manual' carve-out)
 *   counted_adjustments      → admin_balance_adjustment (counted credits)
 *
 * DELIBERATELY NOT covered:
 *   affiliate_claim          → MOVED WHOLESALE to the Creators Costs box
 *                              (owner decision, 2026-07-02): affiliate-code
 *                              earners are creator-program recipients, same
 *                              reasoning as the other Creators Costs lines.
 *                              This box counts $0 of it — no double-count,
 *                              Creators Costs now counts the full sum.
 *   affiliate_leaderboard_prize → creator-run leaderboard payout, counted
 *                              wholly (full gross) in the Creators Costs box,
 *                              EXCLUDED from this box (owner, 2026-06-04)
 *   rain_win / rain_tip      → replaced by the flat $2/hr rain model
 *
 * NON-ledger lines added on top (NOT in `REWARD_PAYOUT_TYPES`):
 *   daily_packs              → packs.pack_type='reward' giveaway inventory
 *   raffles                  → today-window completed raffles' prize JSON
 *                              valued at live pack/card price (no ledger leg)
 *   motha                    → motha account's creator_tip + battle_sponsorship
 *                              debits + motha-funded rain_tips today (RESIDUAL
 *                              / WAGER / rain-funding rows, not in any other
 *                              line — see the module docstring)
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
    // read; the non-DB flat-$2/hr rain line is added at the wrapper either
    // way); off/comparison serve Postgres. Parity confirmed cent-exact.
    return rewardCostsTodayLinesFromPg(sinceIso);
  },
  // v3: affiliate line MOVED WHOLESALE to Creators Costs (owner, 2026-07-02) —
  // no longer read/surfaced here. v2: split race/raffle, surface affiliate +
  // motha as their own lines.
  ["dashboard-reward-costs-today-v3"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

async function rewardCostsTodayLinesFromPg(
  sinceIso: string,
): Promise<{ lines: RewardCostLine[] }> {
  return withTiming("dashboard.rewardCostsToday", async () => {
    const queryDb = await getDrizzleDb();
    const since = `'${sinceIso}'::timestamptz`;

      // ── Ledger reward legs (today) ───────────────────────────────────
      // SAME canonical scope + SAME carve-outs as getRewardCost, broken
      // out per operator-friendly category. affiliate_claim MOVED WHOLESALE
      // to the Creators Costs box (owner, 2026-07-02) — not read here.
      // rain_win/rain_tip are NOT summed (flat $2/h model handled at the
      // wrapper).
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
      const ledgerRows = await queryRows<LedgerRow[]>(queryDb,
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

      // ── Motha giveaways today (founder account outflows) ─────────────
      // The three channels modeled by `insights-rewards/motha/overview.ts`:
      //   • creator_tip funded by motha (founder→user tip)
      //   • battle_sponsorship funded by motha (founder sponsoring battles)
      //   • rain_tips funded by motha (founder topping up the rain pool)
      // None of these land in any other line above (creator_tip is RESIDUAL,
      // battle_sponsorship is WAGER, rain_tips funds the rain pool which the
      // flat-$2/hr rain line uses unrelated of any pool tip sum), so no
      // double-count with the rest of the breakdown. NOT scope-filtered —
      // motha IS the subject of the line, not a customer being measured.
      // If the account does not exist, both reads return 0.
      type MothaIdRow = { id: string };
      const mothaIdRows = await queryRows<MothaIdRow[]>(queryDb,
        `SELECT id FROM "user" WHERE LOWER(username) = $1 LIMIT 1`,
        MOTHA_USERNAME,
      );
      const mothaId = mothaIdRows[0]?.id ?? null;

      let mothaCost = 0;
      if (mothaId != null) {
        type MothaLedgerRow = { motha_ledger: string };
        type MothaRainRow = { motha_rain: string };
        const [mothaLedgerRows, mothaRainRows] = await Promise.all([
          queryRows<MothaLedgerRow[]>(queryDb,
            `SELECT
               COALESCE(SUM(ABS(amount::numeric)), 0)::text AS motha_ledger
             FROM ledger_transactions
             WHERE status = 'completed'
               AND user_id = $1
               AND type::text IN ('creator_tip','battle_sponsorship')
               AND created_at >= ${since}`,
            mothaId,
          ),
          queryRows<MothaRainRow[]>(queryDb,
            `SELECT
               COALESCE(SUM(ABS(amount_usd::numeric)), 0)::text AS motha_rain
             FROM rain_tips
             WHERE user_id = $1
               AND created_at >= ${since}`,
            mothaId,
          ),
        ]);
        mothaCost =
          toNumber(mothaLedgerRows[0]?.motha_ledger) +
          toNumber(mothaRainRows[0]?.motha_rain);
      }

      // ── Raffles today (reconstructed prize cost) ─────────────────────
      // Raffles pay out pack/card ITEMS recorded as a `prizes` JSON array on
      // the `raffles` row — NO ledger money leg — so the cost is RECONSTRUCTED
      // by valuing each completed-today raffle's prize lines at the live
      // pack/card price (the same valuation `getRaffleForecastBaseline` uses,
      // scoped to today). Customer scope on the winner (`userScopeSql` drops
      // staff/creator/blacklist exactly like the canonical helper). NOT in
      // any other ledger line above (raffles never emit a ledger row), so no
      // double-count with the race_prize line.
      type RaffleRow = {
        id: string;
        prizes: unknown;
      };
      const raffleRows = await queryRows<RaffleRow[]>(queryDb,
        `SELECT r.id, r.prizes
         FROM raffles r
         WHERE r.status = 'completed'
           AND r.completed_at IS NOT NULL
           AND r.completed_at >= ${since}
           AND r.winner_user_id IN ${scope.userScopeSql}`,
      );
      let raffleCost = 0;
      if (raffleRows.length > 0) {
        // Parse prizes once, collect referenced pack/card ids, value each via
        // a single `IN (…)` price lookup (not per-raffle).
        type Prize = { type: "pack" | "card"; id: string; qty: number };
        const parsed: Array<{ raffleId: string; prizes: Prize[] }> = [];
        const packIds = new Set<string>();
        const cardIds = new Set<string>();
        for (const row of raffleRows) {
          if (!Array.isArray(row.prizes)) continue;
          const prizes: Prize[] = [];
          for (const p of row.prizes) {
            if (p == null || typeof p !== "object") continue;
            const rec = p as Record<string, unknown>;
            const t = rec.type;
            const id = rec.id;
            if ((t !== "pack" && t !== "card") || typeof id !== "string" || id.length === 0) {
              continue;
            }
            const qtyRaw = Number(rec.quantity);
            const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;
            prizes.push({ type: t, id, qty });
            if (t === "pack") packIds.add(id);
            else cardIds.add(id);
          }
          if (prizes.length > 0) parsed.push({ raffleId: row.id, prizes });
        }

        const [packRows, cardRows] = await Promise.all([
          packIds.size > 0
            ? queryRows<{ id: string; price: string }[]>(
                queryDb,
                `SELECT id, price::text AS price
                 FROM packs
                 WHERE id = ANY($1::text[])`,
                [...packIds],
              )
            : Promise.resolve([] as Array<{ id: string; price: unknown }>),
          cardIds.size > 0
            ? queryRows<{ id: string; price: string }[]>(
                queryDb,
                `SELECT id, price::text AS price
                 FROM cards
                 WHERE id = ANY($1::text[])`,
                [...cardIds],
              )
            : Promise.resolve([] as Array<{ id: string; price: unknown }>),
        ]);
        const packPrice = new Map(packRows.map((p) => [p.id, toNumber(p.price)]));
        const cardPrice = new Map(cardRows.map((c) => [c.id, toNumber(c.price)]));

        for (const { prizes } of parsed) {
          for (const p of prizes) {
            const unit = p.type === "pack" ? packPrice.get(p.id) ?? 0 : cardPrice.get(p.id) ?? 0;
            raffleCost += unit * p.qty;
          }
        }
      }

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
      const packRows = await queryRows<PackRow[]>(queryDb,
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
          label: "Race wins",
          amount: toNumber(lr?.race),
        },
        {
          key: "raffles",
          label: "Raffle prizes",
          amount: raffleCost,
        },
        {
          key: "motha",
          label: "Motha giveaways",
          amount: mothaCost,
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
}

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

    // INVARIANT: the displayed `total` is the sum of every line above.
    // The breakdown popover renders the same lines and the same total;
    // they must agree (the operator reconciles the two by eye). If a new
    // line is added above without being summed here, the box would show a
    // total that does not match the breakdown — explicit reduce keeps the
    // two coupled.
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

// ─── Race win claimant drilldown (lazy, click-to-load) ───────────────────

/** One race-prize payout credited today (one ledger row). */
export type RaceWinClaimRow = {
  userId: string;
  username: string | null;
  /** Prize amount for this claim (ABS ledger amount). */
  amount: number;
  /** daily | weekly | monthly when present on the ledger metadata. */
  raceType: string | null;
  claimedAtIso: string;
};

export type RaceWinClaimantsBreakdown = {
  /** Individual claims today, largest amount first. */
  claims: RaceWinClaimRow[];
  /** Σ claim amounts — reconciles to the card's "Race wins" line. */
  totalAmount: number;
  /** ISO window start (today 00:00 UTC). */
  dayStartIso: string;
};

/**
 * Per-claimant breakdown for the Reward Costs card's "Race wins" line.
 * Uses the SAME canonical metrics scope + today window as the cached
 * `race_prize` aggregate on the card. Lazy — not called on initial render.
 */
export async function getRaceWinClaimants(): Promise<RaceWinClaimantsBreakdown> {
  return withTiming("dashboard.rewardCostsToday.raceClaimants", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    const sinceSql = `'${sinceIso}'::timestamptz`;

    const queryDb = await getDrizzleDb();
    const scope = await getMetricsScope();

    type Row = {
      user_id: string;
      username: string | null;
      amount: string;
      race_type: string | null;
      claimed_at: Date;
    };
    const rows = await queryRows<Row[]>(queryDb,
      `WITH ${scope.sessionWindowsCte}
       SELECT
         lt.user_id,
         u.username,
         ABS(lt.amount::numeric)::text AS amount,
         lt.metadata->>'race_type' AS race_type,
         lt.created_at AS claimed_at
       FROM ledger_transactions lt
       JOIN "user" u ON u.id = lt.user_id
       WHERE lt.status = 'completed'
         AND lt.type::text = 'race_prize'
         AND lt.user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("lt.user_id", "lt.created_at")}
         AND lt.created_at >= ${sinceSql}
       ORDER BY ABS(lt.amount::numeric) DESC, lt.created_at DESC`,
    );

    const claims: RaceWinClaimRow[] = rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      amount: toNumber(r.amount),
      raceType: r.race_type,
      claimedAtIso: new Date(r.claimed_at).toISOString(),
    }));

    const totalAmount = claims.reduce((sum, c) => sum + c.amount, 0);

    return { claims, totalAmount, dayStartIso: sinceIso };
  });
}

// ─── Promo balance credit claimant drilldown (lazy, click-to-load) ───────

/** One counted balance-adjustment CREDIT booked today (one ledger row). */
export type PromoBalanceCreditClaimRow = {
  userId: string;
  username: string | null;
  /** Credited amount for this row (ABS ledger amount, always > 0). */
  amount: number;
  /** Raw counted-adjustment category key (giveaway / bonus / reload / …). */
  category: string | null;
  /** Operator-friendly category label (resolved from the canonical meta). */
  categoryLabel: string | null;
  creditedAtIso: string;
};

export type PromoBalanceCreditClaimantsBreakdown = {
  /** Individual credits today, largest amount first. */
  claims: PromoBalanceCreditClaimRow[];
  /** Σ credit amounts — reconciles to the card's "Promo balance credits" line. */
  totalAmount: number;
  /** ISO window start (today 00:00 UTC). */
  dayStartIso: string;
};

/**
 * Per-recipient breakdown for the Reward Costs card's "Promo balance
 * credits" line. Uses the SAME canonical metrics scope + today window +
 * counted-adjustment predicate as the cached `counted_adjustments` aggregate
 * on the card (`countedAdjustmentSqlPredicate`: `admin_balance_adjustment`
 * credits with a COUNTED `metadata.adjustment_category`, `amount > 0`), so the
 * per-row total reconciles to the line. Each row carries its category so the
 * operator sees WHY each user got credited (giveaway / bonus / reload /
 * lossback / deposit-fix / bug-comp). Lazy — not called on initial render.
 */
export async function getPromoBalanceCreditClaimants(): Promise<PromoBalanceCreditClaimantsBreakdown> {
  return withTiming(
    "dashboard.rewardCostsToday.promoCreditClaimants",
    async () => {
      const now = new Date();
      const since = utcStartOfDay(now);
      const sinceIso = since.toISOString();
      const sinceSql = `'${sinceIso}'::timestamptz`;

      const queryDb = await getDrizzleDb();
      const scope = await getMetricsScope();
      const countedAdj = countedAdjustmentSqlPredicate({
        typeColumn: "lt.type",
        metadataColumn: "lt.metadata",
        amountColumn: "lt.amount",
      });

      type Row = {
        user_id: string;
        username: string | null;
        amount: string;
        category: string | null;
        credited_at: Date;
      };
      const rows = await queryRows<Row[]>(queryDb,
        `WITH ${scope.sessionWindowsCte}
         SELECT
           lt.user_id,
           u.username,
           ABS(lt.amount::numeric)::text AS amount,
           lt.metadata->>'adjustment_category' AS category,
           lt.created_at AS credited_at
         FROM ledger_transactions lt
         JOIN "user" u ON u.id = lt.user_id
         WHERE lt.status = 'completed'
           AND (${countedAdj})
           AND lt.user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("lt.user_id", "lt.created_at")}
           AND lt.created_at >= ${sinceSql}
         ORDER BY ABS(lt.amount::numeric) DESC, lt.created_at DESC`,
      );

      const claims: PromoBalanceCreditClaimRow[] = rows.map((r) => {
        const category = r.category;
        const categoryLabel =
          category != null && isBalanceAdjustmentCategory(category)
            ? BALANCE_ADJUSTMENT_CATEGORY_META[category].costLabel
            : null;
        return {
          userId: r.user_id,
          username: r.username,
          amount: toNumber(r.amount),
          category,
          categoryLabel,
          creditedAtIso: new Date(r.credited_at).toISOString(),
        };
      });

      const totalAmount = claims.reduce((sum, c) => sum + c.amount, 0);

      return { claims, totalAmount, dayStartIso: sinceIso };
    },
  );
}
