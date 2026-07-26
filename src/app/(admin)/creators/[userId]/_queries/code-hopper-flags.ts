import "server-only";

import { getDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";

/**
 * Per-user "code-hopper" (code-switcher) flag for a set of referred
 * users — reuses the exact code-switching signal from the streamers
 * abuse-detection surface (`src/lib/queries/insights-streamers/code-
 * switching.ts`): a user is a code-switcher when they have used **2+
 * DISTINCT affiliate codes** across `usage_type IN ('deposit','wager')`.
 *
 * That's the canonical leaderboard-sniping / code-hopping pattern —
 * switch in to claim a creator's prize, switch back out. Surfacing it on
 * a creator's top-referred-users list lets an admin instantly tell
 * whether the creator's headline numbers are inflated by users who only
 * passed through their code.
 *
 * Design — kept BATCHED on purpose:
 *   The slim `getCodeReferrals` query that powers the top-users list was
 *   deliberately stripped of per-row correlated subqueries because
 *   `affiliate_code_usages` has no index beyond its PK and per-row scans
 *   were timing out. So instead of bolting a `COUNT(DISTINCT code)`
 *   sub-select onto every referral row, this is ONE grouped query over
 *   the already-resolved user-id set: `GROUP BY referred_user_id HAVING
 *   COUNT(DISTINCT UPPER(code)) >= 2`. That keeps the cost to a single
 *   round-trip regardless of list size.
 *
 *   `code` / `usage_type` comparisons use `::text` casts so a missing
 *   enum member can never trip `22P02` — same hardening the streamers
 *   query uses.
 *
 * Returns a Map keyed by user id → distinct-code count (always ≥ 2;
 * non-switchers are absent from the map). Read-only against Main DB.
 */
export type CodeHopperInfo = {
  /** DISTINCT affiliate codes this user has used (deposit/wager). ≥ 2. */
  distinctCodeCount: number;
};

export async function getCodeHopperFlags(
  referredUserIds: string[],
): Promise<Map<string, CodeHopperInfo>> {
  const out = new Map<string, CodeHopperInfo>();
  if (referredUserIds.length === 0) return out;

  const db = await getDrizzleDb();

  try {
    const rows = await queryRows<
      { user_id: string; code_count: string }[]
    >(db,
      `SELECT acu.referred_user_id AS user_id,
              COUNT(DISTINCT UPPER(acu.code))::text AS code_count
         FROM affiliate_code_usages acu
        WHERE acu.referred_user_id = ANY($1::text[])
          AND acu.usage_type::text IN ('deposit', 'wager')
        GROUP BY acu.referred_user_id
       HAVING COUNT(DISTINCT UPPER(acu.code)) >= 2`,
      referredUserIds,
    );

    for (const r of rows) {
      const count = Number(r.code_count);
      if (Number.isFinite(count) && count >= 2) {
        out.set(r.user_id, { distinctCodeCount: count });
      }
    }
  } catch (err) {
    // Best-effort enrichment: if this throws (e.g. acu table absent on a
    // dev DB, or a timeout on the un-indexed scan), the top-users list
    // still renders — just without the code-hopper badges. The error is
    // logged so the operator has a breadcrumb.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[creators.code-hopper-flags] flag query threw, rendering top users without code-hopper badges: ${msg}`,
    );
  }

  return out;
}
