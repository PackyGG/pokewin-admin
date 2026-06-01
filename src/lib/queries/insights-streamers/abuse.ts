import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import { periodSqlInterval, type StreamerPeriod } from "@/app/(admin)/insights/streamers/types";
import type { CreatorRiskRow, SignalScore } from "./types";

/**
 * Per-creator abuse / sus-behaviour scoring.
 *
 * Scoring philosophy:
 *   Each signal contributes 0..100 points. The page renders the
 *   capped sum. Per CLAUDE.md: 50+ amber, 75+ rose. Each signal also
 *   has a short label + optional detail for the drawer.
 *
 * Signals implemented inline (FIXED):
 *   1. Inactive cohort     — % of referred users below the wager
 *                            threshold ($50 lifetime). >70% → 35 pts.
 *   2. Code-switch share   — % of cohort that used ≥2 distinct codes.
 *                            >40% → 25 pts (gradient up from 20%).
 *   3. Burst signups       — max signups in any 1-hour window. >5×
 *                            mean / >10 raw → 20 pts.
 *   4. Borrow-mode share   — % of cohort wager that was battle borrow
 *                            (sponsorship-funded, indicates wager farming
 *                            patterns). > 30% → 20 pts.
 *
 * PROPOSED (need data we haven't observed in the codebase):
 *   - "Creator self-play during own stream": requires the creator
 *     session window CTE (creator-session-windows.ts) joined with
 *     ledger transactions where user_id = creator. We have the CTE
 *     helper already — adding this signal as a follow-up keeps the
 *     first ship lean and avoids the fan-out cost on every page render
 *     until we know it's the signal admins watch most.
 *   - "Suspicious pack RTP / upgrader hit rate": requires per-pack
 *     payout data, which is currently aggregated in
 *     dashboard-upgrader.ts at a global level. A per-cohort z-score
 *     would need a join against game_session results that we don't yet
 *     surface in queries/.
 *   - "Withdraw-and-redeposit cycle": pattern detection requires a
 *     streaming window over ledger_transactions per user. Costly. Drop
 *     in once we have a precomputed creator_risk_scores table (see
 *     "Future hardening" below).
 *
 * Future hardening:
 *   Today the query is computed live with a 10-minute cache. If the
 *   cohort distribution scales, swap it to a cron-populated admin DB
 *   table `creator_risk_scores` (cron pushes scores every 10 min, page
 *   reads cached rows). The signal contract above is data-only so the
 *   migration path is read-only.
 *
 * Read-only against Main DB.
 */

const TTL_SECONDS = 600;

function scoreFromRatio(ratio: number, threshold: number, max: number): number {
  // Linear ramp: 0 at threshold, `max` at 2× threshold.
  if (ratio <= threshold) return 0;
  const r = Math.min(1, (ratio - threshold) / threshold);
  return Math.round(r * max);
}

async function fetchInner(period: StreamerPeriod): Promise<CreatorRiskRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistRu = blacklistNotInClause("ru.id", excluded);
  const interval = periodSqlInterval(period);
  const acuPeriodPredicate = interval ? `AND acu.created_at >= NOW() - ${interval}` : "";

  type Row = {
    user_id: string;
    username: string | null;
    primary_code: string | null;
    referred_count: string;
    cohort_wager: string;
    // Signals
    inactive_pct: string; // 0..1
    multi_code_pct: string; // 0..1
    max_hourly_signups: string;
    mean_hourly_signups: string; // numeric mean
    borrow_share: string; // 0..1
  };

  // ONE query with all the per-creator signal aggregates. Each CTE
  // returns one row per creator with the metric of interest, then the
  // top SELECT joins them. LEFT JOINs everywhere so a creator with no
  // cohort still shows up with zeros — important so the page can sort
  // them onto the bottom rather than dropping them silently.
  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH creators AS (
      SELECT u.id, u.username,
             (SELECT ac.code FROM affiliate_codes ac
              WHERE ac.user_id = u.id
              ORDER BY ac.created_at ASC LIMIT 1) AS primary_code
        FROM "user" u
       WHERE u.role = 'creator'
    ),
    -- Cohort base: referred users (deduped), excluding staff/creator
    cohort_users AS (
      SELECT DISTINCT acu.affiliate_user_id AS creator_id, acu.referred_user_id AS ru_id
        FROM affiliate_code_usages acu
        JOIN "user" ru ON ru.id = acu.referred_user_id
       WHERE ru.role NOT IN ('admin', 'support', 'creator')
         ${blacklistRu}
    ),
    cohort_stats AS (
      SELECT cu.creator_id AS user_id,
             COUNT(*)::int AS referred_count,
             -- Inactive = lifetime wager < $50. The canonical lifetime
             -- wager total lives on balances.total_wagered (kept up to
             -- date by every ledger wager event). A user with no
             -- balances row has never deposited or wagered → 0.
             COUNT(*) FILTER (
               WHERE COALESCE(b.total_wagered::numeric, 0) < 50
             )::int AS inactive_count
        FROM cohort_users cu
        LEFT JOIN balances b ON b.user_id = cu.ru_id
       GROUP BY cu.creator_id
    ),
    -- Multi-code share: of this creator's referrals, how many used
    -- ≥2 distinct codes lifetime? Switch-y.
    cohort_codes AS (
      SELECT cu.creator_id AS user_id,
             SUM(CASE
               WHEN (
                 SELECT COUNT(DISTINCT UPPER(acu2.code))
                   FROM affiliate_code_usages acu2
                  WHERE acu2.referred_user_id = cu.ru_id
               ) >= 2 THEN 1 ELSE 0
             END)::int AS multi_code_count
        FROM cohort_users cu
       GROUP BY cu.creator_id
    ),
    -- Burst signups: max signups per hour for this creator's code.
    -- Compared against the mean per-hour rate so a creator with
    -- consistently high signups doesn't false-alarm.
    --
    -- Two windows compose here:
    --   • Lifetime period: always restrict bucketing to the last 30
    --     days so the per-hour baseline is meaningful (hourly buckets
    --     over years would drown out a real recent burst).
    --   • Shorter period: use the period itself, since 24h/3d/7d are
    --     all narrower than 30d.
    signup_hours AS (
      SELECT cu.creator_id AS user_id,
             date_trunc('hour', ru.created_at) AS bucket,
             COUNT(*)::int AS n
        FROM cohort_users cu
        JOIN "user" ru ON ru.id = cu.ru_id
       WHERE ru.created_at >= NOW() - ${interval ? interval : "INTERVAL '30 days'"}
       GROUP BY cu.creator_id, date_trunc('hour', ru.created_at)
    ),
    signup_stats AS (
      SELECT user_id,
             COALESCE(MAX(n), 0)::int AS max_hourly,
             COALESCE(AVG(n), 0)::numeric AS mean_hourly
        FROM signup_hours
       GROUP BY user_id
    ),
    -- Cohort wager booked against THIS creator code. Restrict the
    -- join to affiliate_user_id = cu.creator_id so a user who later
    -- switched codes does not double-count their wager onto both
    -- creators cohort-wager totals.
    wager_stats AS (
      SELECT cu.creator_id AS user_id,
             COALESCE(SUM(acu.wager_amount_usd::numeric), 0) AS cohort_wager
        FROM cohort_users cu
        LEFT JOIN affiliate_code_usages acu
          ON acu.referred_user_id = cu.ru_id
         AND acu.affiliate_user_id = cu.creator_id
         AND acu.usage_type::text = 'wager'
         ${acuPeriodPredicate}
       GROUP BY cu.creator_id
    ),
    -- Borrow share: total battle bet vs the slice that was funded by
    -- pack-borrow (battles.borrow_percentage). Defenders against
    -- "wager farming" where a creator's referred user takes high-
    -- borrow battles to inflate apparent volume without committing
    -- their own balance.
    battle_borrow_stats AS (
      SELECT cu.creator_id AS user_id,
             COALESCE(SUM(b.bet_amount::numeric), 0) AS battle_wagered,
             COALESCE(SUM(b.bet_amount::numeric * (b.borrow_percentage / 100.0)), 0) AS borrow_wagered
        FROM cohort_users cu
        JOIN battles b ON b.user_id = cu.ru_id
        WHERE b.status = 'completed'
          ${interval ? `AND b.created_at >= NOW() - ${interval}` : ""}
       GROUP BY cu.creator_id
    )
    SELECT c.id AS user_id, c.username, c.primary_code,
           COALESCE(cs.referred_count, 0)::text AS referred_count,
           COALESCE(ws.cohort_wager, 0)::text     AS cohort_wager,
           CASE WHEN COALESCE(cs.referred_count, 0) > 0
             THEN (cs.inactive_count::numeric / cs.referred_count::numeric)::text
             ELSE '0'
           END AS inactive_pct,
           CASE WHEN COALESCE(cs.referred_count, 0) > 0
             THEN (COALESCE(cc.multi_code_count, 0)::numeric / cs.referred_count::numeric)::text
             ELSE '0'
           END AS multi_code_pct,
           COALESCE(ss.max_hourly, 0)::text AS max_hourly_signups,
           COALESCE(ss.mean_hourly, 0)::text AS mean_hourly_signups,
           CASE WHEN COALESCE(bbs.battle_wagered, 0) > 0
             THEN (bbs.borrow_wagered / bbs.battle_wagered)::text
             ELSE '0'
           END AS borrow_share
      FROM creators c
      LEFT JOIN cohort_stats   cs  ON cs.user_id = c.id
      LEFT JOIN cohort_codes   cc  ON cc.user_id = c.id
      LEFT JOIN signup_stats   ss  ON ss.user_id = c.id
      LEFT JOIN wager_stats    ws  ON ws.user_id = c.id
      LEFT JOIN battle_borrow_stats bbs ON bbs.user_id = c.id
  `);

  // Score & rank in TS so the math is testable / inspectable.
  const result: CreatorRiskRow[] = rows.map((r) => {
    const referredCount = Number(r.referred_count);
    const cohortWagerUsd = toNumber(r.cohort_wager);
    const inactivePct = Number(r.inactive_pct);
    const multiCodePct = Number(r.multi_code_pct);
    const maxHourlySignups = Number(r.max_hourly_signups);
    const meanHourlySignups = Number(r.mean_hourly_signups);
    const borrowShare = Number(r.borrow_share);

    const signals: SignalScore[] = [];

    // ── 1. Inactive cohort (low-quality referral signal) ────────
    if (referredCount >= 5 && inactivePct > 0.5) {
      const score = scoreFromRatio(inactivePct, 0.5, 35);
      if (score > 0) {
        signals.push({
          score,
          label: "Low-quality cohort",
          detail: `${Math.round(inactivePct * 100)}% never wagered $50+`,
        });
      }
    }

    // ── 2. Code-switching share (sniping signal) ────────────────
    if (referredCount >= 5 && multiCodePct > 0.2) {
      const score = scoreFromRatio(multiCodePct, 0.2, 25);
      if (score > 0) {
        signals.push({
          score,
          label: "Cohort code-switching",
          detail: `${Math.round(multiCodePct * 100)}% used 2+ codes`,
        });
      }
    }

    // ── 3. Burst signups (botting signal) ───────────────────────
    // Skip when sample is too small to be meaningful.
    if (
      maxHourlySignups >= 8 &&
      (meanHourlySignups < 0.5 || maxHourlySignups >= meanHourlySignups * 5)
    ) {
      // Score scales with how far above baseline the spike is.
      const ratio =
        meanHourlySignups > 0 ? maxHourlySignups / meanHourlySignups : 10;
      const score = Math.min(20, Math.round(ratio * 2));
      signals.push({
        score,
        label: "Burst signups",
        detail: `${maxHourlySignups} in 1h (avg ${meanHourlySignups.toFixed(2)}/h)`,
      });
    }

    // ── 4. Borrow-mode share (wager farming) ────────────────────
    if (borrowShare > 0.3) {
      const score = scoreFromRatio(borrowShare, 0.3, 20);
      if (score > 0) {
        signals.push({
          score,
          label: "Heavy borrow battles",
          detail: `${Math.round(borrowShare * 100)}% borrow share`,
        });
      }
    }

    const totalRiskScore = Math.min(
      100,
      signals.reduce((acc, s) => acc + s.score, 0),
    );

    return {
      userId: r.user_id,
      username: r.username,
      primaryCode: r.primary_code,
      totalRiskScore,
      signals,
      referredCount,
      cohortWagerUsd,
    };
  });

  // Sort: highest risk first, ties broken by cohort size so unflagged
  // big creators still surface near the top of the unflagged tail.
  result.sort((a, b) => {
    if (b.totalRiskScore !== a.totalRiskScore) {
      return b.totalRiskScore - a.totalRiskScore;
    }
    return b.referredCount - a.referredCount;
  });

  return result;
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-abuse-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getCreatorRiskRows(period: StreamerPeriod) {
  return cached(period);
}
