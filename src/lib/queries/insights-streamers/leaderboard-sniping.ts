import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import { getStreamerSchemaProbe } from "./_schema-probe";
import { periodSqlInterval, type StreamerPeriod } from "@/app/(admin)/insights/streamers/types";
import type { LeaderboardSnipeRow } from "./types";

/**
 * Leaderboard-sniping detection: race winners whose acu code history
 * shows a switch around the time of the claim.
 *
 * Methodology:
 *   1. Pull `race_claims` in the period — each row is (user, race_type,
 *      period_start, position, prize_amount_usd, claimed_at).
 *   2. For each claim, find the user's "code at claim" = the most
 *      recent acu row (any usage_type) ≤ `claimed_at` with created_at
 *      within a 14-day lookback. Captures the active referral cookie
 *      at the moment of the win.
 *   3. Find the user's "most recent code" = the latest acu row of
 *      usage_type IN (deposit, wager) AFTER `claimed_at`.
 *   4. A "switched away" flag fires when codeAtClaim and mostRecentCode
 *      both exist and differ.
 *   5. Count DISTINCT codes lifetime; report when ≥ 2.
 *
 * We only return rows where the user has used 2+ DISTINCT codes
 * lifetime — that's the population where sniping is even possible.
 *
 * SCHEMA-ADAPTIVE: the entire tab is built on `race_claims` correlated
 * with `affiliate_code_usages`. The schema probe gates both — on a DB
 * lacking either table the query is skipped and an empty list is
 * returned (the tab shows its empty state) instead of throwing `42P01`.
 *
 * Read-only against Main DB. 10-minute cache.
 */

const TTL_SECONDS = 600;
const ROW_LIMIT = 100;

async function fetchInner(period: StreamerPeriod): Promise<LeaderboardSnipeRow[]> {
  const db = await getDb();
  const probe = await getStreamerSchemaProbe();

  // The whole surface is a race-claim × code-history correlation. Either
  // table missing → no rows possible, return empty (tab empty state)
  // rather than throwing.
  if (!probe.hasRaceClaims || !probe.hasAffiliateCodeUsages) {
    return [];
  }

  const excluded = await getExcludedUserIds();
  const blacklistU = blacklistNotInClause("u.id", excluded);
  const interval = periodSqlInterval(period);
  const claimPeriodPredicate = interval ? `AND rc.claimed_at >= NOW() - ${interval}` : "";

  type Row = {
    user_id: string;
    username: string | null;
    race_type: "daily" | "weekly" | "monthly";
    race_period_start: Date;
    position: number;
    prize_usd: string;
    claimed_at: Date;
    code_at_claim: string | null;
    most_recent_code: string | null;
    total_codes_used: string;
  };

  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH base_claims AS (
      SELECT rc.user_id, rc.race_type, rc.race_period_start,
             rc.position, rc.prize_amount_usd, rc.claimed_at
        FROM race_claims rc
        JOIN "user" u ON u.id = rc.user_id
       WHERE u.role NOT IN ('admin', 'support', 'creator')
         ${blacklistU}
         ${claimPeriodPredicate}
    ),
    -- Only consider users with ≥2 distinct codes lifetime — the
    -- population where sniping is possible at all.
    code_count AS (
      SELECT acu.referred_user_id AS user_id,
             COUNT(DISTINCT UPPER(acu.code)) AS n
        FROM affiliate_code_usages acu
       GROUP BY acu.referred_user_id
      HAVING COUNT(DISTINCT UPPER(acu.code)) >= 2
    ),
    sniper_claims AS (
      SELECT bc.*
        FROM base_claims bc
        JOIN code_count cc ON cc.user_id = bc.user_id
    )
    SELECT sc.user_id,
           u.username,
           sc.race_type::text AS race_type,
           sc.race_period_start,
           sc.position,
           sc.prize_amount_usd::text AS prize_usd,
           sc.claimed_at,
           (
             SELECT UPPER(acu.code)
               FROM affiliate_code_usages acu
              WHERE acu.referred_user_id = sc.user_id
                AND acu.created_at <= sc.claimed_at
                AND acu.created_at >= sc.claimed_at - INTERVAL '14 days'
              ORDER BY acu.created_at DESC
              LIMIT 1
           ) AS code_at_claim,
           (
             SELECT UPPER(acu.code)
               FROM affiliate_code_usages acu
              WHERE acu.referred_user_id = sc.user_id
                AND acu.created_at > sc.claimed_at
                AND acu.usage_type::text IN ('deposit', 'wager')
              ORDER BY acu.created_at DESC
              LIMIT 1
           ) AS most_recent_code,
           (
             SELECT cc.n::text FROM code_count cc WHERE cc.user_id = sc.user_id
           ) AS total_codes_used
      FROM sniper_claims sc
      JOIN "user" u ON u.id = sc.user_id
     ORDER BY sc.prize_amount_usd::numeric DESC, sc.claimed_at DESC
     LIMIT ${ROW_LIMIT}
  `);

  return rows.map((r) => {
    const codeAtClaim = r.code_at_claim;
    const mostRecentCode = r.most_recent_code;
    const switchedAway =
      !!codeAtClaim &&
      !!mostRecentCode &&
      codeAtClaim !== mostRecentCode;
    return {
      userId: r.user_id,
      username: r.username,
      raceType: r.race_type,
      racePeriodStart: r.race_period_start.toISOString(),
      position: r.position,
      prizeUsd: toNumber(r.prize_usd),
      codeAtClaim,
      totalCodesUsed: Number(r.total_codes_used),
      mostRecentCode,
      switchedAway,
    };
  });
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-snipe-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getLeaderboardSnipers(period: StreamerPeriod) {
  return cached(period);
}
