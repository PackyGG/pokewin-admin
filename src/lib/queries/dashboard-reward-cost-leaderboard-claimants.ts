import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getMetricsScope } from "@/lib/metrics/scope";

/**
 * Per-user drilldown for the dashboard "Reward costs today" breakdown's
 * **Leaderboard prizes** line — WHICH real customers received on-site /
 * platform leaderboard prize payouts since 00:00 UTC today, and how much.
 *
 * ─── It MIRRORS the breakdown line definition EXACTLY, nothing new ──────
 *
 * The breakdown's "Leaderboard prizes" figure
 * (`@/lib/queries/dashboard-reward-costs-today.ts`, the `leaderboards`
 * CASE sum) is:
 *
 *   Σ ABS(amount)  over  ledger_transactions
 *   WHERE type = 'affiliate_leaderboard_prize'    (a REWARD_PAYOUT_TYPES
 *                                                  member — the house-funded
 *                                                  leaderboard PRIZE leg, NOT
 *                                                  an affiliate commission)
 *     AND status = 'completed'
 *     AND user_id IN <getMetricsScope().userScopeSql>   (staff + creators +
 *                                                        blacklist dropped)
 *     AND <getMetricsScope().notInCreatorSession(user_id, created_at)>
 *     AND created_at >= <today 00:00 UTC>
 *
 * This function GROUPs that same predicate BY user_id and joins the
 * username, so the listed claimants' amounts sum EXACTLY to the breakdown
 * line total (e.g. −$2,865.00). The scope, the ledger type, the
 * `status='completed'` filter and the today-00:00-UTC window are all
 * resolved from the SAME sources — there is no second definition to drift.
 *
 * House-POV per CLAUDE.md: a leaderboard prize is money the house PAID OUT
 * to a user (a user GAIN) → a house COST → rendered rose at the call site.
 *
 * ─── PERFORMANCE ────────────────────────────────────────────────────────
 *
 * NOT cached and NOT called on the dashboard's initial render — the
 * per-user GROUP BY is heavier than the single-row breakdown sweep, so it
 * lives behind a click (the popover expander fires a server action that
 * calls this). Today-only window — no lifetime scan. One indexed
 * `created_at >= today-00:00` aggregate, ordered by magnitude, lightly
 * capped. The `since` instant is computed by the caller (the server
 * action) from the live `now`, never frozen.
 */

/** One claimant row in the leaderboard-prize drilldown. */
export type LeaderboardPrizeClaimantRow = {
  userId: string;
  username: string | null;
  /**
   * Absolute dollar magnitude of leaderboard prizes this user received in
   * the window (house cost, always >= 0). Sum across rows reconciles to
   * the breakdown's "Leaderboard prizes" line total.
   */
  amount: number;
};

/**
 * UTC start-of-day for the instant `now`. Identical boundary to the
 * reward-costs box (`dashboard-reward-costs-today.ts` `utcStartOfDay`) so
 * the drilldown window matches the line it explains exactly.
 */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Resolve the real customers who received `affiliate_leaderboard_prize`
 * payouts since 00:00 UTC today, with per-user totals. Mirrors the
 * breakdown's `leaderboards` line predicate one-for-one (same canonical
 * scope, same ledger type, same `status='completed'`, same window) so the
 * rows reconcile to the line total.
 *
 * `limit` caps the row count (defensive — the value comes from a server
 * action); ordered by amount DESC so the largest prizes surface first.
 */
export async function getLeaderboardPrizeClaimantsToday(
  limit = 100,
): Promise<LeaderboardPrizeClaimantRow[]> {
  return withTiming("dashboard.leaderboardPrizeClaimantsToday", async () => {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const since = utcStartOfDay(new Date());
    const sinceSql = `'${since.toISOString()}'::timestamptz`;

    const db = await getDb();
    // SAME canonical scope as the reward-costs breakdown: staff + creators
    // dropped wholesale, blacklist dropped, creator-on-session rows
    // excluded. `getMetricsScope` is cheap to re-resolve (React-cached
    // blacklist + 5-min-cached session windows).
    const scope = await getMetricsScope();

    type ClaimantRow = {
      user_id: string;
      username: string | null;
      amount: string;
    };
    const rows = await db.$queryRawUnsafe<ClaimantRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         lt.user_id AS user_id,
         u.username AS username,
         COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS amount
       FROM ledger_transactions lt
       JOIN "user" u ON u.id = lt.user_id
       WHERE lt.type::text = 'affiliate_leaderboard_prize'
         AND lt.status = 'completed'
         AND lt.user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("lt.user_id", "lt.created_at")}
         AND lt.created_at >= ${sinceSql}
       GROUP BY lt.user_id, u.username
       HAVING COALESCE(SUM(ABS(lt.amount::numeric)), 0) > 0
       ORDER BY SUM(ABS(lt.amount::numeric)) DESC
       LIMIT ${safeLimit}`,
    );

    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      amount: toNumber(r.amount),
    }));
  });
}
