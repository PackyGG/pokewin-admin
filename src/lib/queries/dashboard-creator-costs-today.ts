import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getLeaderboardSponsorshipMap } from "@/app/(admin)/creators/_queries/leaderboard-sponsorship";

/**
 * "Creators Costs (today)" dashboard box — what CREATORS cost the house for
 * the CURRENT CALENDAR DAY since 00:00 UTC (NOT a rolling past-24h window).
 * Same UTC-midnight boundary as the Reward Costs Today tile
 * (`dashboard-reward-costs-today.ts` `utcStartOfDay`) and the P&L Today tile,
 * so the three reconcile on "today".
 *
 * ─── It REUSES the canonical creator-cost definitions, not new math ──────
 *
 * Every line mirrors EXACTLY a definition that already exists elsewhere,
 * just re-scoped to [today 00:00 UTC, now):
 *
 *   • Creator withdrawals today — the SAME `creator_deal_payouts` CTE the
 *     dashboard's "Creator Deal Payouts (withdrawn)" tile uses
 *     (`getDashboardStats` in `dashboard.ts`): Σ `vouchers.value` of the two
 *     creator deal-payout voucher origins (`creator_fill_conversion` +
 *     `creator_multiplier_payout`) attached (`vouchers.id = ANY(cwr.voucher_ids)`)
 *     to a completed/shipped `card_withdrawal_requests`, scoped by the
 *     request's money-out timestamp (`COALESCE(completed_at, shipped_at)`).
 *     DISTINCT on (request, voucher) so a voucher listed twice in one
 *     request's array can't be summed twice. The two origins are disjoint →
 *     no double-count between the payout types. This is the REAL house
 *     creator cost (deal payouts the creator actually cashed out), NOT a
 *     creator's personal balance cash-out.
 *
 *   • Tips today — the `creator_fill_spend_tip` leg of
 *     `creators/_queries/tips-sponsor-spend.ts` (creator-funded tips handed
 *     to users from the house-funded tips/sponsor pool), scoped to today.
 *     Filtered via `type::text IN (...)` (NOT a bare enum literal) so a
 *     `creator_fill_*` member absent from the prod enum simply matches zero
 *     rows instead of throwing `invalid input value for enum` at parse time
 *     — exactly the ENUM-SAFETY pattern documented in `tips-sponsor-spend.ts`.
 *     The box safely reads $0 until the fill system is live.
 *
 *   • Leaderboard spend today — the `affiliate_leaderboard_prize` ledger
 *     payouts for today (the SAME canonical leaderboard-prize type the
 *     Reward Costs box counts as its "leaderboards" line, and the
 *     `@/lib/metrics` reward set classifies as a REWARD_PAYOUT). Surfaced
 *     BOTH ways:
 *       – 100%      = Σ |amount| of today's prize rows — the full pool that
 *                     went out to players today.
 *       – our cut   = the house-funded share after each board's off-site
 *                     sponsor %, using the SAME sponsored-% house-share logic
 *                     as `creators/_queries/leaderboard-cost.ts`: each prize
 *                     row carries `metadata.leaderboard_id`, weighted by the
 *                     admin-set sponsored % from
 *                     `getLeaderboardSponsorshipMap` (admin DB), defaulting to
 *                     100% (full cost) when un-annotated / no leaderboard id —
 *                     identical convention to leaderboard-cost.ts.
 *
 * House-POV per CLAUDE.md: every line is money the house PAID OUT (creators
 * cashing out deal payouts, house-funded tips, house-funded leaderboard
 * prizes) → a house cost → rose in the UI. The TOTAL uses the leaderboard
 * OUR-CUT figure (the actual house outflow), not the 100% pool — the 100%
 * figure is shown alongside for context only.
 *
 * ─── PERFORMANCE ────────────────────────────────────────────────────────
 *
 * Today-only window — no lifetime scan. `unstable_cache` keyed on the UTC
 * day string (revalidate 60s, same cadence as the reward-costs tile),
 * wrapped in `safeQuery` at the call site, streamed in its own `<Suspense>`
 * so it never blocks the dashboard shell. Two today-bounded reads (one
 * withdrawal-voucher aggregate, one ledger tips+leaderboard aggregate that
 * also returns the per-board prize split for the sponsorship weighting),
 * then one small admin-DB sponsorship lookup keyed on just today's distinct
 * leaderboard ids. No staff/blacklist scope: these are creator-fill / deal /
 * leaderboard spend legs (the receiving user is whoever the creator
 * paid/sponsored), so the gross house spend is the honest figure — matching
 * how the canonical per-creator + tile definitions sum them.
 */

/** One creator-cost line on the box. */
export type CreatorCostLine = {
  /** Stable key for React. */
  key: string;
  /** Operator-friendly label. */
  label: string;
  /** Absolute dollar magnitude (house cost, always >= 0). */
  amount: number;
};

export type CreatorCostsToday = {
  /**
   * Total creator cost today — creator withdrawals + tips + leaderboard
   * OUR-CUT (the actual house outflow; the 100% pool is context only).
   */
  total: number;
  /** Itemized lines, largest magnitude first. */
  lines: CreatorCostLine[];
  /** Creator deal-payout withdrawals cashed out today (rose). */
  creatorWithdrawals: number;
  /** House-funded creator tips today (rose). */
  tips: number;
  /** Full leaderboard prize pool paid out today (100%, context only). */
  leaderboardFull: number;
  /** House-funded share of today's leaderboard prizes (after sponsor %). */
  leaderboardOurCut: number;
  /** ISO timestamp of the window start (today 00:00 UTC). */
  dayStartIso: string;
};

/**
 * UTC start-of-day for the instant `now`. Mirrors the Reward Costs / P&L
 * Today boxes' boundary so all three agree on "today".
 */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Cached inner computation. Keyed on the UTC day string so it re-fills when
 * the day rolls over. `revalidate: 60` matches the reward-costs tile cadence.
 *
 * Runs three reads:
 *   1. Creator deal-payout withdrawals cashed out today (voucher aggregate).
 *   2. Today's creator tips + the per-leaderboard prize split (ledger).
 *   3. Sponsored % for just today's distinct leaderboard ids (admin DB).
 *
 * The leaderboard OUR-CUT is then derived in JS exactly as
 * leaderboard-cost.ts derives houseCoveredUsd: Σ rowPrize × (pct / 100),
 * pct defaulting to 100 when un-annotated / missing leaderboard id.
 */
const cachedCreatorCostsToday = unstable_cache(
  async (
    dayKey: string,
    sinceIso: string,
  ): Promise<{
    creatorWithdrawals: number;
    tips: number;
    leaderboardFull: number;
    leaderboardOurCut: number;
  }> => {
    void dayKey; // part of the cache key only
    return withTiming("dashboard.creatorCostsToday", async () => {
      const db = await getDb();
      const since = `'${sinceIso}'::timestamptz`;

      // ── Creator deal-payout withdrawals cashed out today ─────────────
      // SAME CTE as the dashboard's Creator Deal Payouts tile
      // (creator_deal_payouts in dashboard.ts): Σ voucher value of the two
      // creator deal-payout origins attached to a completed/shipped
      // withdrawal request, scoped by the request's money-out timestamp.
      // DISTINCT (request, voucher) so a doubly-listed voucher can't be
      // summed twice; the two origins are disjoint so no cross-count.
      type WithdrawalRow = { creator_withdrawals: string };
      const withdrawalRows = await db.$queryRawUnsafe<WithdrawalRow[]>(
        `WITH creator_deal_payouts AS (
           SELECT DISTINCT
             cwr.id AS request_id,
             v.id   AS voucher_id,
             v.value::numeric AS amount,
             COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
           FROM card_withdrawal_requests cwr
           JOIN vouchers v ON v.id = ANY(cwr.voucher_ids)
           WHERE cwr.status IN ('completed', 'shipped')
             AND v.origin::text IN ('creator_fill_conversion', 'creator_multiplier_payout')
         )
         SELECT COALESCE(SUM(CASE WHEN effective_at >= ${since} THEN amount ELSE 0 END), 0)::text AS creator_withdrawals
         FROM creator_deal_payouts`,
      );
      const creatorWithdrawals = toNumber(withdrawalRows[0]?.creator_withdrawals);

      // ── Creator tips today (house-funded fill-spend tip leg) ─────────
      // `type::text IN (...)` — text comparison, never an enum-membership
      // error if `creator_fill_spend_tip` is absent from the prod enum
      // (see tips-sponsor-spend.ts ENUM-SAFETY header). Matches zero rows
      // until the fill system is live → reads $0 safely.
      type TipsRow = { tips: string };
      const tipsRows = await db.$queryRawUnsafe<TipsRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS tips
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'creator_fill_spend_tip'
           AND created_at >= ${since}`,
      );
      const tips = toNumber(tipsRows[0]?.tips);

      // ── Leaderboard prize payouts today, split per leaderboard ───────
      // affiliate_leaderboard_prize ledger payouts for today (the SAME
      // canonical leaderboard-prize type the Reward Costs box counts). Each
      // row carries metadata.leaderboard_id (backend writes it on the prize
      // event — see users-detail.ts enrichLeaderboardWins). Grouped per
      // leaderboard id so the sponsored-% house-share weighting can be
      // applied per board in JS. NULL/missing leaderboard_id rows fold into
      // a single '(none)' bucket and default to 100% cost (no annotation).
      type BoardRow = { leaderboard_id: string | null; prize: string };
      const boardRows = await db.$queryRawUnsafe<BoardRow[]>(
        `SELECT
           metadata->>'leaderboard_id' AS leaderboard_id,
           COALESCE(SUM(ABS(amount::numeric)), 0)::text AS prize
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'affiliate_leaderboard_prize'
           AND created_at >= ${since}
         GROUP BY metadata->>'leaderboard_id'`,
      );

      const leaderboardFull = boardRows.reduce(
        (sum: number, r: BoardRow) => sum + toNumber(r.prize),
        0,
      );

      // Sponsored % for just today's distinct leaderboard ids (admin DB).
      // Resilient: if the admin-DB lookup blips, treat every board as 100%
      // (our-cut collapses to the full pool) rather than blanking the line —
      // same fallback posture as leaderboard-cost.ts.
      const ids = boardRows
        .map((r: BoardRow) => r.leaderboard_id)
        .filter(
          (id: string | null): id is string =>
            typeof id === "string" && id.length > 0,
        );
      let sponsorship: Map<string, number>;
      try {
        sponsorship = await getLeaderboardSponsorshipMap(ids);
      } catch (e) {
        console.error(
          "[creator-costs-today] sponsorship lookup failed (treating all as 100%):",
          e,
        );
        sponsorship = new Map();
      }

      // OUR-CUT = Σ rowPrize × (pct / 100), pct defaulting to 100 when the
      // board is un-annotated or the row has no leaderboard id — identical
      // weighting + default to leaderboard-cost.ts's houseCoveredUsd.
      const leaderboardOurCut = boardRows.reduce((sum: number, r: BoardRow) => {
        const prize = toNumber(r.prize);
        const pct =
          r.leaderboard_id != null
            ? Math.min(100, Math.max(0, sponsorship.get(r.leaderboard_id) ?? 100))
            : 100;
        return sum + prize * (pct / 100);
      }, 0);

      return { creatorWithdrawals, tips, leaderboardFull, leaderboardOurCut };
    });
  },
  ["dashboard-creator-costs-today-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Creator costs for the current calendar day (since 00:00 UTC). Resolves the
 * cached today-windowed aggregate and assembles the line roster + total.
 *
 * The TOTAL is creator withdrawals + tips + leaderboard OUR-CUT — the actual
 * house outflow. The leaderboard 100% pool is returned as `leaderboardFull`
 * for the box to show alongside the our-cut figure (context, not summed into
 * the total — summing the full pool would double-count the sponsor's off-site
 * share that never costs the house).
 */
export async function getCreatorCostsToday(): Promise<CreatorCostsToday> {
  return withTiming("dashboard.creatorCostsToday.entry", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    // YYYY-MM-DD in UTC — stable cache key for "today" that rolls at 00:00.
    const dayKey = sinceIso.slice(0, 10);

    const { creatorWithdrawals, tips, leaderboardFull, leaderboardOurCut } =
      await cachedCreatorCostsToday(dayKey, sinceIso);

    // Lines for the breakdown popover. The leaderboard line carries the
    // OUR-CUT magnitude (the figure that sums into the total); the box's
    // popover annotates it with the 100% pool. Keep every line — even $0
    // ones — so the breakdown always shows the full roster; the box filters
    // to non-zero for the compact face.
    const lines: CreatorCostLine[] = [
      {
        key: "creator_withdrawals",
        label: "Creator withdrawals",
        amount: creatorWithdrawals,
      },
      { key: "tips", label: "Tips", amount: tips },
      {
        key: "leaderboard",
        label: "Leaderboard spend (our cut)",
        amount: leaderboardOurCut,
      },
    ].sort((a, b) => b.amount - a.amount);

    const total = creatorWithdrawals + tips + leaderboardOurCut;

    return {
      total,
      lines,
      creatorWithdrawals,
      tips,
      leaderboardFull,
      leaderboardOurCut,
      dayStartIso: sinceIso,
    };
  });
}
