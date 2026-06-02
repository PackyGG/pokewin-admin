import "server-only";

import { getDb } from "@/lib/db";

/**
 * Aggregate code-hopper risk for ONE creator's code — a single grouped
 * count, NOT the per-user list.
 *
 * A referred user is a "code-hopper" (code-switcher) when they have used
 * **2+ DISTINCT affiliate codes** across `usage_type IN ('deposit','wager')`
 * — the exact canonical signal the streamers abuse surface and the
 * per-user `getCodeHopperFlags` badge query use (`COUNT(DISTINCT
 * UPPER(code)) >= 2`). That's the leaderboard-sniping / hop-in-hop-out
 * pattern: switch in to farm a creator's prize, switch back out.
 *
 * This returns just the HEADLINE numbers for a small risk tile on the
 * creator-detail page:
 *   • hopperCount    — distinct referred users on THIS code who are
 *                      code-hoppers (used 2+ distinct codes).
 *   • activeCount    — distinct referred users on this code with any
 *                      deposit/wager activity (the denominator the
 *                      affiliate system treats as "real" referrals).
 * so the tile reads "N of M code-users hopped". Drill-down (the per-user
 * badges) already lives on `/creators/[userId]/users`.
 *
 * Cost shape: ONE grouped round-trip scoped by `UPPER(code) = $1`, no
 * per-row correlated subqueries (the same reason `getCodeReferrals` was
 * slimmed — `affiliate_code_usages` has no index beyond its PK). Casing:
 * usages mirror the resolved `affiliate_codes` casing (mixed for legacy
 * rows), so the scope filter and the DISTINCT-code count both
 * `UPPER(...)` to be casing-agnostic — identical to the per-user query.
 *
 * `code` is passed as a BIND PARAMETER ($1), never concatenated.
 *
 * Best-effort: a failure (table absent on a dev DB, PK-only scan timeout)
 * returns `null` so the tile simply doesn't render — the rest of the page
 * is unaffected. The error is logged for a breadcrumb.
 */
export type CodeHopperSummary = {
  /** Distinct code-users on this code who used 2+ distinct codes. */
  hopperCount: number;
  /** Distinct code-users on this code with any deposit/wager activity. */
  activeCount: number;
};

export async function getCodeHopperSummary(
  code: string,
): Promise<CodeHopperSummary | null> {
  const db = await getDb();
  const uppercaseCode = code.toUpperCase();

  try {
    const rows = await db.$queryRawUnsafe<
      { hopper_count: string; active_count: string }[]
    >(
      // Per-user distinct-code counts over this code's deposit/wager
      // users, then aggregate: how many of them crossed the 2-code
      // threshold (hoppers) vs the total active set. UPPER() on both the
      // scope filter and the DISTINCT count keeps mixed-case legacy rows
      // matched, exactly like getCodeHopperFlags. ::text casts on
      // code/usage_type so a missing enum member can never trip 22P02.
      `WITH code_users AS (
         SELECT acu.referred_user_id AS user_id,
                COUNT(DISTINCT UPPER(acu.code::text)) AS distinct_codes
           FROM affiliate_code_usages acu
          WHERE acu.referred_user_id IN (
                  SELECT inner_acu.referred_user_id
                    FROM affiliate_code_usages inner_acu
                   WHERE UPPER(inner_acu.code::text) = $1
                     AND inner_acu.usage_type::text IN ('deposit', 'wager')
                )
            AND acu.usage_type::text IN ('deposit', 'wager')
          GROUP BY acu.referred_user_id
       )
       SELECT
         COUNT(*) FILTER (WHERE distinct_codes >= 2)::text AS hopper_count,
         COUNT(*)::text                                    AS active_count
       FROM code_users`,
      uppercaseCode,
    );

    const r = rows[0];
    const hopperCount = Number(r?.hopper_count ?? 0);
    const activeCount = Number(r?.active_count ?? 0);
    return {
      hopperCount: Number.isFinite(hopperCount) ? hopperCount : 0,
      activeCount: Number.isFinite(activeCount) ? activeCount : 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[creators.code-hopper-summary] aggregate query threw, tile omitted: ${msg}`,
    );
    return null;
  }
}
