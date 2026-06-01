import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import { periodSqlInterval, type StreamerPeriod } from "@/app/(admin)/insights/streamers/types";
import type { CodeSwitcherRow } from "./types";

/**
 * Users who have wagered/deposited under 2+ DISTINCT affiliate codes.
 *
 * This is the canonical "code-switching" surface — the abuse pattern
 * here is leaderboard-sniping (switch in to claim a race prize, switch
 * back) but the same data also shows admins who their cross-creator
 * users are.
 *
 * Methodology:
 *   1. From `affiliate_code_usages`, build the set of users with
 *      COUNT(DISTINCT UPPER(code)) ≥ 2 across `usage_type IN (deposit, wager)`.
 *      Limited to the period via the per-row created_at.
 *   2. For each such user, project the chronology: ordered list of
 *      (code, firstUsedAt, ownerUsername) from the earliest usage of
 *      each distinct code.
 *   3. Cross-reference race_claims to surface "switched in for a race".
 *
 * Per-user race_claims are counted lifetime so a recent switcher who
 * cleaned up an older race shows up. Race prize amounts come from
 * race_claims.prize_amount_usd directly (canonical).
 *
 * Read-only against Main DB. 10-minute cache — switchers are a slow-
 * moving population.
 */

const TTL_SECONDS = 600;
const ROW_LIMIT = 100;

async function fetchInner(period: StreamerPeriod): Promise<CodeSwitcherRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistU = blacklistNotInClause("u.id", excluded);
  const interval = periodSqlInterval(period);
  const acuPeriodPredicate = interval ? `AND acu.created_at >= NOW() - ${interval}` : "";

  type SwitcherRow = {
    user_id: string;
    username: string | null;
    email: string | null;
    code_count: string;
    total_wager: string;
    total_deposits: string;
    race_claim_count: string;
    race_claim_usd: string;
  };

  // First wave: identify the users + headline aggregates. We constrain
  // to "switched WITHIN the period" — meaning the user used a code in
  // the window AND their distinct-code count over LIFETIME is ≥ 2.
  // (If we restricted distinct-codes to the window too, we'd miss
  // users who set up the switch outside the window and only winned
  // inside it — which is the very pattern we want to surface.)
  const switchers = await db.$queryRawUnsafe<SwitcherRow[]>(`
    WITH switchers AS (
      SELECT acu.referred_user_id AS user_id
        FROM affiliate_code_usages acu
       WHERE acu.usage_type::text IN ('deposit', 'wager')
       GROUP BY acu.referred_user_id
      HAVING COUNT(DISTINCT UPPER(acu.code)) >= 2
    ),
    in_window AS (
      SELECT DISTINCT acu.referred_user_id AS user_id
        FROM affiliate_code_usages acu
       WHERE acu.usage_type::text IN ('deposit', 'wager')
       ${interval ? acuPeriodPredicate : `AND TRUE`}
    ),
    sw_users AS (
      SELECT s.user_id
        FROM switchers s
        ${interval ? `JOIN in_window iw ON iw.user_id = s.user_id` : ""}
    )
    SELECT u.id AS user_id, u.username, u.email,
           (
             SELECT COUNT(DISTINCT UPPER(acu.code))
               FROM affiliate_code_usages acu
              WHERE acu.referred_user_id = u.id
           )::text AS code_count,
           COALESCE((
             SELECT SUM(acu.wager_amount_usd::numeric)
               FROM affiliate_code_usages acu
              WHERE acu.referred_user_id = u.id
                AND acu.usage_type::text = 'wager'
                ${acuPeriodPredicate}
           ), 0)::text AS total_wager,
           COALESCE((
             SELECT SUM(acu.deposit_amount_usd::numeric)
               FROM affiliate_code_usages acu
              WHERE acu.referred_user_id = u.id
                AND acu.usage_type::text = 'deposit'
                ${acuPeriodPredicate}
           ), 0)::text AS total_deposits,
           COALESCE((
             SELECT COUNT(*)
               FROM race_claims rc
              WHERE rc.user_id = u.id
           ), 0)::text AS race_claim_count,
           COALESCE((
             SELECT SUM(rc.prize_amount_usd::numeric)
               FROM race_claims rc
              WHERE rc.user_id = u.id
           ), 0)::text AS race_claim_usd
      FROM sw_users sw
      JOIN "user" u ON u.id = sw.user_id
     WHERE u.role NOT IN ('admin', 'support', 'creator')
       ${blacklistU}
     ORDER BY (
       SELECT COUNT(DISTINCT UPPER(acu.code))
         FROM affiliate_code_usages acu
        WHERE acu.referred_user_id = u.id
     ) DESC,
       (SELECT SUM(rc.prize_amount_usd::numeric)
          FROM race_claims rc
         WHERE rc.user_id = u.id) DESC NULLS LAST
     LIMIT ${ROW_LIMIT}
  `);

  if (switchers.length === 0) return [];

  // Second wave: chronology per user. Pull the earliest acu row per
  // (user, UPPER(code)) so the table can show the switch order.
  // owner_username links to the creator who owned each code at first
  // use; null when the code came from a non-creator (e.g. a backfilled
  // / legacy code).
  const userIds = switchers.map((s) => s.user_id);
  type ChronoRow = {
    user_id: string;
    code: string;
    first_used_at: Date;
    owner_username: string | null;
  };

  // Per-query isolation: the chronology is a secondary enrichment. If
  // it throws, we still return the switcher list (the spine of the tab)
  // with empty chronology arrays rather than blanking the whole tab via
  // safeQuery's fallback tile. All columns proven against schema.prisma
  // (affiliate_code_usages.code/created_at/usage_type, affiliate_codes).
  const chronoByUser = new Map<string, CodeSwitcherRow["codeChronology"]>();
  try {
    const chrono = await db.$queryRawUnsafe<ChronoRow[]>(
      `
      SELECT acu.referred_user_id AS user_id,
             UPPER(acu.code) AS code,
             MIN(acu.created_at) AS first_used_at,
             (
               SELECT u_owner.username
                 FROM affiliate_codes ac
                 LEFT JOIN "user" u_owner ON u_owner.id = ac.user_id
                WHERE UPPER(ac.code) = UPPER(acu.code)
                ORDER BY ac.created_at ASC
                LIMIT 1
             ) AS owner_username
        FROM affiliate_code_usages acu
       WHERE acu.referred_user_id = ANY($1::text[])
         AND acu.usage_type::text IN ('deposit', 'wager')
       GROUP BY acu.referred_user_id, UPPER(acu.code)
       ORDER BY acu.referred_user_id, MIN(acu.created_at) ASC
      `,
      userIds,
    );
    for (const c of chrono) {
      const list = chronoByUser.get(c.user_id) ?? [];
      list.push({
        code: c.code,
        firstUsedAt: c.first_used_at.toISOString(),
        ownerUsername: c.owner_username,
      });
      chronoByUser.set(c.user_id, list);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[insights-streamers.code-switching] chronology query threw, rendering switchers without code order: ${msg}`,
    );
  }

  return switchers.map((s) => ({
    userId: s.user_id,
    username: s.username,
    email: s.email,
    codeChronology: chronoByUser.get(s.user_id) ?? [],
    codeCount: Number(s.code_count),
    totalWagerUsd: toNumber(s.total_wager),
    totalDepositsUsd: toNumber(s.total_deposits),
    raceClaimCount: Number(s.race_claim_count),
    raceClaimUsd: toNumber(s.race_claim_usd),
  }));
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-codeswitch-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getCodeSwitchers(period: StreamerPeriod) {
  return cached(period);
}
