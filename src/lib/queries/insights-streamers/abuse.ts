import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import { getStreamerSchemaProbe } from "./_schema-probe";
import { periodSqlInterval, type StreamerPeriod } from "@/app/(admin)/insights/streamers/types";
import type { CreatorRiskRow, SignalScore } from "./types";
import {
  getCreatorSelfPlayMap,
  type CreatorSelfPlayRow,
} from "./creator-self-play";
import {
  getCohortGameAnomalyMap,
  type CohortGameAnomalyRow,
} from "./cohort-rtp-anomaly";
import {
  getCycleSignalMap,
  type CycleSignalRow,
} from "./withdraw-redeposit-cycle";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Per-creator abuse / sus-behaviour scoring.
 *
 * Scoring philosophy:
 *   Each signal carries 0..N points. The combined risk score is the
 *   MAX across signals (not the sum) so a creator with one critical
 *   signal still surfaces — a creator who is clearly cycling
 *   leaderboards but has a small cohort shouldn't get diluted by six
 *   zero signals.
 *
 * Per CLAUDE.md: 50+ amber, 75+ rose. Each signal also carries a
 * short label + optional detail for the drawer.
 *
 * All seven signals (FIXED):
 *   1. Inactive cohort     — % of referred users below the wager
 *                            threshold ($50 lifetime). Cohort-quality
 *                            proxy.
 *                            Source: this file (inline).
 *
 *   2. Code-switch share   — % of cohort that used ≥2 distinct codes.
 *                            Sniping indicator.
 *                            Source: this file (inline).
 *
 *   3. Burst signups       — max signups in any 1-hour window vs the
 *                            mean. Botting indicator.
 *                            Source: this file (inline).
 *
 *   4. Borrow-mode share   — % of cohort wager that was battle borrow.
 *                            Wager-farming indicator.
 *                            Source: this file (inline).
 *
 *   5. Creator self-play   — creator's share of total wager flowing
 *      during stream         during their own live windows. The
 *                            centerpiece "wager abuse" signal.
 *                            Source: ./creator-self-play.ts
 *
 *   6. Cohort RTP / hit-   — z-score of cohort pack RTP and upgrader
 *      rate anomaly          hit rate vs the population baseline.
 *                            Surfaces "this creator's cohort hits
 *                            weirdly". Source: ./cohort-rtp-anomaly.ts
 *
 *   7. Cycle detection     — % of cohort with ≥2 deposit→wager→
 *                            withdraw→redeposit-with-different-code
 *                            cycles. The leaderboard-farm signal.
 *                            Source: ./withdraw-redeposit-cycle.ts
 *
 * Hardening / scaling:
 *   Signals 5/6/7 are computed live with caches (10 min for 5/6,
 *   30 min for 7). Past a few thousand active cohort users, signal 7
 *   should be migrated to a daily cron writing into an admin DB table
 *   `creator_cohort_cycle_scores`. The cron output shape would match
 *   `CycleSignalRow` so the page swap is read-only.
 *
 * SCHEMA-ADAPTIVE: this file uses the shared schema probe end to end.
 *   The inline 1-4 query is gated on `affiliate_code_usages` and its
 *   `balances` (signal 1) / `battles` (signal 4) reads degrade to a
 *   0-contribution when those tables are absent — no `42P01`, and the
 *   surviving inline signals still run (finer-grained than the old
 *   all-or-nothing try/catch). The enum-/table-sensitive signals 5
 *   (self-play `upgrader_bet`) and 6 (`upgrader_games`) are guarded
 *   inside their own modules, so on a DB that predates the upgrader
 *   launch they quietly contribute nothing instead of throwing. Each of
 *   signals 5/6/7 is additionally fetched via `Promise.allSettled`, so a
 *   failure in one never blanks the others.
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

/**
 * Per-signal failure logger. We never want one busted signal query to
 * blank the whole risk panel — the rest should still render with that
 * signal contributing 0. The log line is the only breadcrumb the
 * operator has, since the page itself silently degrades.
 */
function logSignalFailure(signalName: string, reason: unknown): void {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(
    `[insights-streamers.abuse] signal '${signalName}' threw, falling back to zero-score for every creator: ${msg}`,
  );
}

async function fetchInner(period: StreamerPeriod): Promise<CreatorRiskRow[]> {
  const db = await getDb();
  const probe = await getStreamerSchemaProbe();
  const excluded = await getExcludedUserIds();
  const blacklistRu = blacklistNotInClause("ru.id", excluded);
  const interval = periodSqlInterval(period);
  const acuPeriodPredicate = interval ? `AND acu.created_at >= NOW() - ${interval}` : "";

  // Pull the three new signal maps in parallel with the inline SQL.
  // Each returns Map<creatorId, row>. Empty rows = no signal — they
  // don't push a SignalScore entry.
  //
  // Per-signal isolation: each map is fetched independently and a
  // failure in any one of them degrades to an empty map (= 0-score on
  // that signal for every creator) instead of taking the whole abuse
  // aggregate down. A bug in cohort-rtp-anomaly shouldn't blank the
  // self-play signal, and vice versa — the page becomes resilient
  // instead of all-or-nothing.
  const [selfPlayResult, anomalyResult, cycleResult] = await Promise.allSettled(
    [
      getCreatorSelfPlayMap(period),
      getCohortGameAnomalyMap(period),
      getCycleSignalMap(period),
    ],
  );
  const selfPlayMap: Map<string, CreatorSelfPlayRow> =
    selfPlayResult.status === "fulfilled"
      ? selfPlayResult.value
      : (logSignalFailure("creator-self-play", selfPlayResult.reason),
        new Map());
  const anomalyMap: Map<string, CohortGameAnomalyRow> =
    anomalyResult.status === "fulfilled"
      ? anomalyResult.value
      : (logSignalFailure("cohort-rtp-anomaly", anomalyResult.reason),
        new Map());
  const cycleMap: Map<string, CycleSignalRow> =
    cycleResult.status === "fulfilled"
      ? cycleResult.value
      : (logSignalFailure("withdraw-redeposit-cycle", cycleResult.reason),
        new Map());

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
  //
  // Per-signal isolation: this query covers inline signals 1-4. If it
  // throws, we still try to render the page using only signals 5/6/7
  // from the maps above — we synthesize a minimum set of creator rows
  // from the union of map keys so the score-from-signals path still
  // works. Better to show a partial risk view with one bad signal
  // group than nothing at all.
  //
  // SCHEMA-ADAPTIVE: the whole query is gated on `affiliate_code_usages`
  // (the cohort spine). The inactive-cohort signal reads `balances` and
  // the borrow-battle signal reads `battles`; each is gated on its table
  // so a DB missing one degrades THAT signal to 0 without throwing
  // `42P01` and without killing the other inline signals. `usage_type` /
  // `battle.status` comparisons use `::text` casts so a missing enum
  // member can never trip `22P02`.
  //
  //   • balances present → real inactive count; absent → inactive_count
  //     forced to 0 (signal contributes nothing).
  //   • battles present  → real borrow share; absent → an empty CTE so
  //     borrow_share resolves to 0.
  const inactiveCountExpr = probe.hasBalances
    ? `COUNT(*) FILTER (
               WHERE COALESCE(b.total_wagered::numeric, 0) < 50
             )::int`
    : `0`;
  const balancesJoin = probe.hasBalances
    ? `LEFT JOIN balances b ON b.user_id = cu.ru_id`
    : ``;
  // Borrow CTE: real aggregate when `battles` exists, otherwise an
  // empty-shaped relation so the LEFT JOIN + COALESCE downstream yields
  // borrow_share = 0 (no signal). `b.status::text` avoids any enum throw.
  const battleBorrowCte = probe.hasBattles
    ? `battle_borrow_stats AS (
      SELECT cu.creator_id AS user_id,
             COALESCE(SUM(b.bet_amount::numeric), 0) AS battle_wagered,
             COALESCE(SUM(b.bet_amount::numeric * (b.borrow_percentage / 100.0)), 0) AS borrow_wagered
        FROM cohort_users cu
        JOIN battles b ON b.user_id = cu.ru_id
        WHERE b.status::text = 'completed'
          ${interval ? `AND b.created_at >= NOW() - ${interval}` : ""}
       GROUP BY cu.creator_id
    )`
    : `battle_borrow_stats AS (
      SELECT NULL::text AS user_id,
             0::numeric AS battle_wagered,
             0::numeric AS borrow_wagered
       WHERE false
    )`;

  // Synthesize a minimum row per creator that still appears in any of
  // the signal maps so signals 5-7 can render even when the inline
  // 1-4 query couldn't run (table absent OR threw). The inline-signal
  // fields are 0 here; those signals are gated by `referredCount >= 5`
  // downstream, so a 0 means they contribute nothing — the intended
  // degradation, not a fabricated score.
  const synthesizeFromMaps = (): Row[] => {
    const userIds = new Set<string>([
      ...selfPlayMap.keys(),
      ...anomalyMap.keys(),
      ...cycleMap.keys(),
    ]);
    return Array.from(userIds, (uid) => ({
      user_id: uid,
      username: null,
      primary_code: null,
      referred_count: "0",
      cohort_wager: "0",
      inactive_pct: "0",
      multi_code_pct: "0",
      max_hourly_signups: "0",
      mean_hourly_signups: "0",
      borrow_share: "0",
    }));
  };

  let rows: Row[] = [];
  if (!probe.hasAffiliateCodeUsages) {
    // No cohort source at all — render the map-only synthesis (signals
    // 5-7). Don't even attempt the inline query (its cohort spine is
    // gone).
    logSignalFailure(
      "inline-1-to-4",
      new Error("affiliate_code_usages table absent — inline signals skipped"),
    );
    rows = synthesizeFromMaps();
  } else {
    try {
      rows = await db.$queryRawUnsafe<Row[]>(`
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
             ${inactiveCountExpr} AS inactive_count
        FROM cohort_users cu
        ${balancesJoin}
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
    -- their own balance. Schema-gated (see battleBorrowCte above).
    ${battleBorrowCte}
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
    } catch (err) {
      // One bad inline-signal group shouldn't blank the page — fall back
      // to the map-only synthesis so signals 5-7 still render.
      logSignalFailure("inline-1-to-4", err);
      rows = synthesizeFromMaps();
    }
  }

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

    // ── 5. Creator self-play during own stream ──────────────────
    const sp = selfPlayMap.get(r.user_id);
    if (sp && sp.score > 0 && sp.selfShare !== null) {
      signals.push({
        score: sp.score,
        label: "Self-play on stream",
        detail:
          `${Math.round(sp.selfShare * 100)}% of stream wager from creator` +
          ` (${formatCurrency(sp.selfWagerUsd)})`,
      });
    }

    // ── 6. Cohort game-outcome anomaly (RTP / hit-rate z) ───────
    const an = anomalyMap.get(r.user_id);
    if (an && an.score > 0) {
      // Pick the larger |z| of the two for the headline; the other
      // is included in the detail so the admin sees both.
      const packZAbs = an.packZ !== null ? Math.abs(an.packZ) : 0;
      const upZAbs = an.upgraderZ !== null ? Math.abs(an.upgraderZ) : 0;
      const isPack = packZAbs >= upZAbs;
      const headlineLabel = isPack ? "Pack RTP anomaly" : "Upgrader hit-rate anomaly";
      const z = isPack ? an.packZ : an.upgraderZ;
      const cohortPct =
        isPack && an.cohortPackRtp !== null
          ? `${(an.cohortPackRtp * 100).toFixed(1)}%`
          : !isPack && an.cohortUpHitRate !== null
            ? `${(an.cohortUpHitRate * 100).toFixed(1)}%`
            : "";
      const basePct = isPack
        ? `${(an.baselinePackRtp * 100).toFixed(1)}%`
        : `${(an.baselineUpHitRate * 100).toFixed(1)}%`;
      signals.push({
        score: an.score,
        label: headlineLabel,
        detail:
          `cohort ${cohortPct} vs baseline ${basePct}` +
          (z !== null ? ` (z=${z.toFixed(2)})` : ""),
      });
    }

    // ── 7. Withdraw-redeposit cycle (leaderboard farm) ──────────
    const cy = cycleMap.get(r.user_id);
    if (cy && cy.score > 0 && cy.cycleShare !== null) {
      signals.push({
        score: cy.score,
        label: "Cycle pattern",
        detail:
          `${cy.flaggedUsers}/${cy.cohortSize} cohort users` +
          ` (${Math.round(cy.cycleShare * 100)}%)` +
          ` with ≥2 deposit→withdraw→re-deposit cycles`,
      });
    }

    // Combined risk = MAX of component scores, not sum. One critical
    // signal should surface a creator, not get diluted by zero
    // signals on the other axes.
    const totalRiskScore = signals.reduce(
      (acc, s) => (s.score > acc ? s.score : acc),
      0,
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
  // v2: signals 5/6/7 added + scoring switched from sum→max so
  // a creator with one critical signal still surfaces.
  ["insights-streamers-abuse-v2"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getCreatorRiskRows(period: StreamerPeriod) {
  return cached(period);
}
