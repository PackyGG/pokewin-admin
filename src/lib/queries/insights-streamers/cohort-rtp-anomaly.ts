import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import {
  periodSqlInterval,
  type StreamerPeriod,
} from "@/app/(admin)/insights/streamers/types";

/**
 * Signal 6 — Cohort game-outcome anomaly (RTP / upgrader-hit-rate z).
 *
 * For each creator's referred cohort we compute their actual game
 * outcomes and compare against the platform-wide baseline. Two
 * sub-signals:
 *
 *   1. Pack RTP:
 *        cohortPackRtp  = SUM(pack inventory value_at_obtained) /
 *                         SUM(non-borrow pack wager).
 *        baselinePackRtp = same ratio computed across the population
 *                          of ALL real-customer cohorts in the window.
 *        packZ = (cohortPackRtp - baselinePackRtp) / σ_cohortPackRtp,
 *        where σ is the stdev across per-creator cohort RTPs (the
 *        population from which the z is meaningful).
 *
 *   2. Upgrader hit rate:
 *        cohortUpHitRate  = wins / bets across the cohort's upgrader
 *                           plays.
 *        baselineUpHitRate = same ratio across all real-customer
 *                            cohort plays in the window.
 *        upgraderZ = (cohort - baseline) / σ_cohortUpHitRate.
 *
 * Combined score = MAX(|packZ|, |upgraderZ|) bucketed:
 *   |z| < 1.5 → 0 (normal variance)
 *   1.5 ≤ |z| < 2.5 → 30 pts (amber band)
 *   |z| ≥ 2.5 → 60 pts (rose band — far outlier)
 *
 * Why the bucketed form rather than a continuous ramp:
 *   Z-scores >3 happen naturally with small cohorts. A continuous
 *   ramp would inflate a tiny cohort's score off raw variance, not
 *   true anomaly. The buckets + per-creator minimum-bet gates below
 *   (need at least 10 pack opens / 10 upgrader bets) are the defence
 *   against statistical false positives.
 *
 * Time scope:
 *   The period filter applies to both the cohort's plays AND the
 *   baseline calculation — so a creator with a 3-day window of weird
 *   outcomes is compared against the platform's 3-day baseline, not
 *   lifetime. Cohort membership is lifetime (`affiliate_code_usages`)
 *   because a 24h window would drop legitimate long-term referrals.
 *
 * Excludes creator-on-stream rows? NO. The pattern we're hunting is
 * "creator's COHORT is hitting weirdly during play" — whether on
 * stream or not. The session window CTE is intentionally not used
 * here. (Signal 5 covers the on-stream piece.)
 *
 * Read-only against Main DB. 10-minute cache, tag `insights-streamers`.
 */

const TTL_SECONDS = 600;

export type CohortGameAnomalyRow = {
  userId: string;
  /** Cohort's observed pack RTP, 0..1 (or higher). null = no opens. */
  cohortPackRtp: number | null;
  baselinePackRtp: number;
  /** z-score against the per-creator-cohort stdev. null when no
   *  baseline yet (no other cohorts have enough plays) or when the
   *  cohort itself doesn't meet the activity floor. */
  packZ: number | null;
  /** Pack-opens count in the period — used for the activity gate. */
  cohortPackOpens: number;

  cohortUpHitRate: number | null;
  baselineUpHitRate: number;
  upgraderZ: number | null;
  cohortUpgraderBets: number;

  /** 0..60 — bucketed max of |packZ|, |upgraderZ|. */
  score: number;
};

async function fetchInner(
  period: StreamerPeriod,
): Promise<Map<string, CohortGameAnomalyRow>> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistC = blacklistNotInClause("c.id", excluded);
  const blacklistRu = blacklistNotInClause("ru.id", excluded);
  const interval = periodSqlInterval(period);
  const ltCutoff = interval ? `AND lt.created_at >= NOW() - ${interval}` : "";
  const uiCutoff = interval
    ? `AND ui.obtained_at >= NOW() - ${interval}`
    : "";
  const ugCutoff = interval ? `AND ug.created_at >= NOW() - ${interval}` : "";

  type PackRow = {
    user_id: string;
    pack_wager: string;
    pack_payout: string;
    pack_opens: string;
  };
  type UpgraderRow = {
    user_id: string;
    up_bets: string;
    up_wins: string;
  };

  // ── Per-creator-cohort pack RTP ─────────────────────────────────
  // Non-borrow wager only (matches the pack RTP definition used by
  // /insights/games — borrowed portion was never the user's money so
  // it shouldn't pollute the RTP signal). Payout = sum of obtained
  // inventory values from non-borrow pack sessions.
  //
  // The same `non_borrow_pack_sessions` CTE pattern as overview.ts
  // — kept inline here so this file isn't coupled to an /insights/games
  // helper.
  const [packRows, upgraderRows] = await Promise.all([
    db.$queryRawUnsafe<PackRow[]>(`
      WITH cohort_users AS (
        SELECT DISTINCT acu.affiliate_user_id AS creator_id,
                        acu.referred_user_id AS ru_id
          FROM affiliate_code_usages acu
          JOIN "user" ru ON ru.id = acu.referred_user_id
         WHERE ru.role NOT IN ('admin', 'support', 'creator')
           ${blacklistRu}
      ),
      non_borrow_pack_sessions AS (
        SELECT game_session_id
          FROM ledger_transactions
         WHERE type = 'pack_opening' AND status = 'completed'
           AND game_session_id IS NOT NULL
           AND (description IS NULL OR description NOT ILIKE '%borrow%')
      ),
      -- Wager-side: SUM of pack open ledger rows on non-borrow sessions
      -- per cohort.
      cohort_pack_wager AS (
        SELECT cu.creator_id AS user_id,
               COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS pack_wager,
               COUNT(*)::int AS pack_opens
          FROM cohort_users cu
          JOIN ledger_transactions lt ON lt.user_id = cu.ru_id
         WHERE lt.status = 'completed'
           AND lt.type = 'pack_opening'
           AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_pack_sessions)
           ${ltCutoff}
         GROUP BY cu.creator_id
      ),
      -- Payout-side: SUM of value_at_obtained for cards from those
      -- non-borrow pack sessions.
      cohort_pack_payout AS (
        SELECT cu.creator_id AS user_id,
               COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS pack_payout
          FROM cohort_users cu
          JOIN user_inventory ui ON ui.user_id = cu.ru_id
         WHERE ui.source_type = 'pack'
           AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions)
           ${uiCutoff}
         GROUP BY cu.creator_id
      )
      SELECT c.id AS user_id,
             COALESCE(cpw.pack_wager, 0)::text AS pack_wager,
             COALESCE(cpp.pack_payout, 0)::text AS pack_payout,
             COALESCE(cpw.pack_opens, 0)::text AS pack_opens
        FROM "user" c
        LEFT JOIN cohort_pack_wager  cpw ON cpw.user_id = c.id
        LEFT JOIN cohort_pack_payout cpp ON cpp.user_id = c.id
       WHERE c.role = 'creator'
         ${blacklistC}
    `),
    // ── Per-creator-cohort upgrader bets + wins ────────────────────
    // upgrader_games.won_amount > 0 = win. The table doesn't have
    // borrow concept (per /insights/games _shared.ts), so we use it
    // directly.
    db.$queryRawUnsafe<UpgraderRow[]>(`
      WITH cohort_users AS (
        SELECT DISTINCT acu.affiliate_user_id AS creator_id,
                        acu.referred_user_id AS ru_id
          FROM affiliate_code_usages acu
          JOIN "user" ru ON ru.id = acu.referred_user_id
         WHERE ru.role NOT IN ('admin', 'support', 'creator')
           ${blacklistRu}
      ),
      cohort_upgrader AS (
        SELECT cu.creator_id AS user_id,
               COUNT(*)::int AS up_bets,
               COUNT(CASE WHEN ug.won_amount::numeric > 0 THEN 1 END)::int AS up_wins
          FROM cohort_users cu
          JOIN upgrader_games ug ON ug.user_id = cu.ru_id
         WHERE TRUE
           ${ugCutoff}
         GROUP BY cu.creator_id
      )
      SELECT c.id AS user_id,
             COALESCE(cu.up_bets, 0)::text AS up_bets,
             COALESCE(cu.up_wins, 0)::text AS up_wins
        FROM "user" c
        LEFT JOIN cohort_upgrader cu ON cu.user_id = c.id
       WHERE c.role = 'creator'
         ${blacklistC}
    `),
  ]);

  // Build per-creator metrics + the population for σ calculation.
  // The population for σ is the set of cohorts with enough activity
  // to be statistically meaningful — using a too-small floor would
  // bake in the noisy tiny-cohort RTPs and shrink σ artificially.
  const PACK_MIN_OPENS = 10;
  const UP_MIN_BETS = 10;

  const packMap = new Map<
    string,
    { rtp: number; wager: number; payout: number; opens: number }
  >();
  for (const r of packRows) {
    const wager = toNumber(r.pack_wager);
    const payout = toNumber(r.pack_payout);
    const opens = Number(r.pack_opens);
    packMap.set(r.user_id, {
      rtp: wager > 0 ? payout / wager : 0,
      wager,
      payout,
      opens,
    });
  }

  const upMap = new Map<
    string,
    { hitRate: number; bets: number; wins: number }
  >();
  for (const r of upgraderRows) {
    const bets = Number(r.up_bets);
    const wins = Number(r.up_wins);
    upMap.set(r.user_id, {
      hitRate: bets > 0 ? wins / bets : 0,
      bets,
      wins,
    });
  }

  // Baseline + σ — only from cohorts meeting the activity floor.
  const packPopulation: number[] = [];
  let baselinePackWager = 0;
  let baselinePackPayout = 0;
  for (const v of packMap.values()) {
    if (v.opens >= PACK_MIN_OPENS) {
      packPopulation.push(v.rtp);
      baselinePackWager += v.wager;
      baselinePackPayout += v.payout;
    }
  }
  const baselinePackRtp =
    baselinePackWager > 0 ? baselinePackPayout / baselinePackWager : 0;
  const packStd = stdev(packPopulation);

  const upPopulation: number[] = [];
  let baselineUpBets = 0;
  let baselineUpWins = 0;
  for (const v of upMap.values()) {
    if (v.bets >= UP_MIN_BETS) {
      upPopulation.push(v.hitRate);
      baselineUpBets += v.bets;
      baselineUpWins += v.wins;
    }
  }
  const baselineUpHitRate = baselineUpBets > 0 ? baselineUpWins / baselineUpBets : 0;
  const upStd = stdev(upPopulation);

  const out = new Map<string, CohortGameAnomalyRow>();
  const creatorIds = new Set<string>();
  for (const r of packRows) creatorIds.add(r.user_id);
  for (const r of upgraderRows) creatorIds.add(r.user_id);

  for (const userId of creatorIds) {
    const pack = packMap.get(userId);
    const up = upMap.get(userId);

    const cohortPackRtp = pack && pack.opens > 0 ? pack.rtp : null;
    const cohortUpHitRate = up && up.bets > 0 ? up.hitRate : null;

    // Z-scores only when (a) cohort meets the activity floor AND (b)
    // σ is non-degenerate. Otherwise null = "no signal".
    const packZ =
      pack && pack.opens >= PACK_MIN_OPENS && packStd > 0
        ? (pack.rtp - baselinePackRtp) / packStd
        : null;
    const upgraderZ =
      up && up.bets >= UP_MIN_BETS && upStd > 0
        ? (up.hitRate - baselineUpHitRate) / upStd
        : null;

    const absMaxZ = Math.max(
      packZ !== null ? Math.abs(packZ) : 0,
      upgraderZ !== null ? Math.abs(upgraderZ) : 0,
    );

    let score = 0;
    if (absMaxZ >= 2.5) {
      // |z| 2.5 → 60. Cap rather than scale further so extreme z's
      // from tiny populations don't single-handedly dominate.
      score = 60;
    } else if (absMaxZ >= 1.5) {
      // |z| 1.5 → 30, scales linearly to 50 by |z| = 2.5.
      const r = (absMaxZ - 1.5) / 1.0;
      score = Math.round(30 + r * 20);
    }

    out.set(userId, {
      userId,
      cohortPackRtp,
      baselinePackRtp,
      packZ,
      cohortPackOpens: pack?.opens ?? 0,
      cohortUpHitRate,
      baselineUpHitRate,
      upgraderZ,
      cohortUpgraderBets: up?.bets ?? 0,
      score,
    });
  }

  return out;
}

/**
 * Sample stdev (Bessel-corrected). Returns 0 for n < 2 — caller checks
 * for non-positive σ before computing z (avoids NaN).
 */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sse = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  return Math.sqrt(sse / (xs.length - 1));
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-cohort-rtp-anomaly-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getCohortGameAnomalyMap(period: StreamerPeriod) {
  return cached(period);
}
