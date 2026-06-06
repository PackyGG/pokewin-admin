import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";
import { getCreatorPnlCached } from "./overview-data";

/**
 * Creator Hub — `creators/[id]` Cohorts & LTV tab data.
 *
 * Answers: how good are the players THIS creator referred, grouped by the
 * month they signed up? signup → FTD → repeat-deposit → churn, plus the
 * lifetime value (deposits / net) each cohort produced.
 *
 * ─── COHORT MODEL ──────────────────────────────────────────────────────
 *
 * A cohort = the set of users with `user.referred_by = <creator>` bucketed
 * by their SIGNUP month (`date_trunc('month', user.created_at)`). `referred_by`
 * is the durable, first-touch attribution link the rest of the creator data
 * layer already trusts for the signup count (see
 * `code-and-wager-by-user.ts`), so the cohort base is byte-consistent with
 * the Overview "Signups" KPI when summed.
 *
 * Per referred user we LEFT JOIN three real, indexed signals — NOTHING is
 * fabricated:
 *   • `balances.total_deposited`            → FTD flag + deposit LTV
 *   • completed `ledger_transactions` of    → repeat-depositor flag (≥2) +
 *     `type='deposit'` count + last date       last-deposit-date for churn
 *   • Σ `affiliate_code_usages.wager_amount_usd` (this creator's code) → wager LTV
 *
 * Funnel definitions (kept identical to the existing creator queries so the
 * numbers reconcile):
 *   • signup           — a `user.referred_by = creator` row (staff/creator
 *                        roles + blacklist excluded, same pool as everywhere).
 *   • FTD (depositor)  — `balances.total_deposited > 0`. Same predicate
 *                        `code-and-wager-by-user`'s lifetime-FTD count uses.
 *   • repeat depositor — ≥2 COMPLETED ledger deposits (a returning player).
 *   • churned          — has deposited but no completed deposit in the last
 *                        30 days (last_deposit_at < NOW() - 30d). Pre-FTD
 *                        users are "never converted", not "churned".
 *
 * ─── LTV ───────────────────────────────────────────────────────────────
 *
 * `depositsUsd` (Σ `balances.total_deposited` over the cohort) is a REAL,
 * directly-queryable lifetime-value figure → shown per cohort + as avg /
 * depositor. House-POV: deposits are cash INTO the house → emerald.
 *
 * NET-to-house LTV (deposits − card-withdrawals) requires the full
 * coverage-attribution session chain, which only exists in `getCreatorPnl`
 * as a SINGLE lifetime figure — NOT per signup-month. Rather than fabricate a
 * per-cohort split we surface that real lifetime net ONCE (reused from
 * `getCreatorPnlCached`, the same number the Overview Creator-Net box shows)
 * and label the per-cohort LTV explicitly as DEPOSITS-based. The UI marks the
 * net figure as a creator-wide total, not a per-cohort value.
 *
 * ─── PERF (LAZY · cached · bounded · timeout-guarded) ──────────────────
 *
 * This whole module runs ONLY when the Cohorts tab is opened (active-tab-only)
 * and is wrapped in `safeQuery` by the caller. The cohort scan is a SINGLE
 * set-based query bounded to a 365-day signup lookback (same
 * `LIFETIME_LOOKBACK_DAYS` guard the creator P&L scan uses) so it never
 * sequential-scans the full user/ledger history. Results are memoized via
 * `unstable_cache` keyed on the creator id, prod-pinned exactly like
 * `_pnl-cache.ts` (a dev-toggled admin bypasses the cache to see live dev
 * data). MAIN/prod game DB is READ-ONLY — every read here is a SELECT.
 */

// Signup-lookback cap (days) for the cohort scan — mirrors the creator P&L
// scan's `LIFETIME_LOOKBACK_DAYS`. The affiliate/creator program is recent
// enough that a rolling 365-day window covers effectively all referred
// signups, so the displayed cohorts are unchanged in practice while the
// scan stays bounded instead of walking the entire user history.
const SIGNUP_LOOKBACK_DAYS = 365;

// Churn boundary — a depositor with no completed deposit in this many days is
// treated as churned. 30d matches the per-window granularity used elsewhere
// on the creator detail page.
const CHURN_WINDOW_DAYS = 30;

/** One signup-month cohort row (house-POV figures resolved). */
export type CohortRow = {
  /** ISO month key, e.g. "2026-03". */
  monthKey: string;
  /** Display label, e.g. "Mar 2026". */
  monthLabel: string;
  /** Users referred by this creator who signed up that month. */
  signups: number;
  /** Of those, how many ever deposited (`total_deposited > 0`). */
  ftds: number;
  /** Of the FTDs, how many made ≥2 completed ledger deposits. */
  repeatDepositors: number;
  /** Of the FTDs, how many are churned (no completed deposit in 30d). */
  churned: number;
  /** Of the FTDs, how many are still active (deposited within 30d). */
  active: number;
  /** Σ lifetime deposits for the cohort (deposits-based LTV → emerald). */
  depositsUsd: number;
  /** Σ wager booked against this creator's code for the cohort. */
  wagerUsd: number;
  /** signup → FTD conversion rate (0–1). */
  ftdRate: number;
  /** FTD → repeat-deposit rate (0–1). */
  repeatRate: number;
  /** Avg lifetime deposits per DEPOSITOR (LTV/FTD). */
  avgDepositPerFtdUsd: number;
};

export type CohortsData = {
  /** Newest-first signup-month cohorts. */
  cohorts: CohortRow[];
  /** Roll-up across every cohort. */
  totals: {
    signups: number;
    ftds: number;
    repeatDepositors: number;
    churned: number;
    active: number;
    depositsUsd: number;
    wagerUsd: number;
    ftdRate: number;
    repeatRate: number;
    avgDepositPerFtdUsd: number;
  };
  /**
   * REAL lifetime net-to-house P&L for this creator's whole cohort
   * (deposits − card-withdrawals via coverage attribution) — the SAME figure
   * the Overview Creator-Net box shows. A creator-WIDE total, NOT split per
   * signup-month (the per-cohort net split isn't queryable — see module doc).
   * null when the (best-effort) P&L scan failed/timed out.
   */
  lifetimeNetUsd: number | null;
  /** The signup-lookback window the cohort scan was bounded to. */
  lookbackDays: number;
  /** The churn boundary used. */
  churnWindowDays: number;
};

type CohortQueryRow = {
  month_key: string;
  signups: string;
  ftds: string;
  repeat_depositors: string;
  churned: string;
  active: string;
  deposits_usd: string;
  wager_usd: string;
};

async function buildBlacklistAnd(): Promise<string> {
  const excluded = await getExcludedUserIds();
  // Leading space intentional — concatenated after another condition.
  return excluded.length > 0
    ? ` AND u.id NOT IN (${escapeBlacklistIds(excluded)})`
    : "";
}

function monthLabel(monthKey: string): string {
  // monthKey is "YYYY-MM"; render "Mon YYYY" without pulling a date lib for a
  // value we already have as a clean string.
  const [year, month] = monthKey.split("-");
  const idx = Number(month) - 1;
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const name = names[idx] ?? month;
  return `${name} ${year}`;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

async function queryCohorts(creatorUserId: string): Promise<CohortsData> {
  const db = await getDb();
  const blacklistAnd = await buildBlacklistAnd();

  // ── Single set-based cohort scan ─────────────────────────────────────
  //
  //   cohort_users — referred users (staff/creator + blacklist excluded),
  //                  signed up within the bounded lookback, with their
  //                  signup month + per-user deposit/wager rollups computed
  //                  via correlated scalar sub-selects on indexed columns:
  //                    • total_deposited      → balances (1:1, indexed by user_id)
  //                    • completed dep count  → idx_ledger_tx_user_type_status_created_at
  //                    • last completed dep   → same index (MAX created_at)
  //                    • Σ this-creator wager → idx_acu_affiliate_user_created_at
  //                                             scoped to referred_user_id
  // Then GROUP BY month to derive the funnel counts + LTV sums per cohort.
  const sql = `WITH cohort_users AS (
       SELECT
         to_char(date_trunc('month', u.created_at), 'YYYY-MM') AS month_key,
         COALESCE(b.total_deposited, 0)::numeric                AS total_deposited,
         (
           SELECT COUNT(*)
             FROM ledger_transactions lt
            WHERE lt.user_id = u.id
              AND lt.type::text = 'deposit'
              AND lt.status::text = 'completed'
         )                                                       AS completed_deposit_count,
         (
           SELECT MAX(lt.created_at)
             FROM ledger_transactions lt
            WHERE lt.user_id = u.id
              AND lt.type::text = 'deposit'
              AND lt.status::text = 'completed'
         )                                                       AS last_deposit_at,
         (
           SELECT COALESCE(SUM(acu.wager_amount_usd::numeric), 0)
             FROM affiliate_code_usages acu
            WHERE acu.affiliate_user_id = $1
              AND acu.referred_user_id = u.id
              AND acu.usage_type::text = 'wager'
         )                                                       AS wager_usd
         FROM "user" u
         LEFT JOIN balances b ON b.user_id = u.id
        WHERE u.referred_by = $1
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND u.id != $1
          AND u.created_at >= NOW() - INTERVAL '${SIGNUP_LOOKBACK_DAYS} days'${blacklistAnd}
     )
     SELECT
       month_key,
       COUNT(*)::text                                                       AS signups,
       COUNT(*) FILTER (WHERE total_deposited > 0)::text                    AS ftds,
       COUNT(*) FILTER (WHERE completed_deposit_count >= 2)::text           AS repeat_depositors,
       COUNT(*) FILTER (
         WHERE total_deposited > 0
           AND (last_deposit_at IS NULL
                OR last_deposit_at < NOW() - INTERVAL '${CHURN_WINDOW_DAYS} days')
       )::text                                                              AS churned,
       COUNT(*) FILTER (
         WHERE total_deposited > 0
           AND last_deposit_at >= NOW() - INTERVAL '${CHURN_WINDOW_DAYS} days'
       )::text                                                              AS active,
       COALESCE(SUM(total_deposited), 0)::text                              AS deposits_usd,
       COALESCE(SUM(wager_usd), 0)::text                                    AS wager_usd
       FROM cohort_users
      GROUP BY month_key
      ORDER BY month_key DESC`;

  // The lifetime net (deposits − cardWD, coverage-attributed) reuses the
  // EXISTING cached creator P&L scan — same number as the Overview Creator-Net
  // box. Best-effort: a failed/slow scan degrades net to null, the cohort
  // table still renders.
  const [rows, pnl] = await Promise.all([
    db.$queryRawUnsafe<CohortQueryRow[]>(sql, creatorUserId),
    getCreatorPnlCached(creatorUserId).catch((e) => {
      console.error(
        "[creator-hub.creators.cohorts] lifetime net P&L failed (net null):",
        e,
      );
      return null;
    }),
  ]);

  const cohorts: CohortRow[] = rows.map((r) => {
    const signups = Number(r.signups);
    const ftds = Number(r.ftds);
    const repeatDepositors = Number(r.repeat_depositors);
    const churned = Number(r.churned);
    const active = Number(r.active);
    const depositsUsd = toNumber(r.deposits_usd);
    const wagerUsd = toNumber(r.wager_usd);
    return {
      monthKey: r.month_key,
      monthLabel: monthLabel(r.month_key),
      signups,
      ftds,
      repeatDepositors,
      churned,
      active,
      depositsUsd,
      wagerUsd,
      ftdRate: ratio(ftds, signups),
      repeatRate: ratio(repeatDepositors, ftds),
      avgDepositPerFtdUsd: ratio(depositsUsd, ftds),
    };
  });

  // Roll-up totals (summed from the per-cohort rows so they always reconcile
  // with the table).
  const sum = cohorts.reduce(
    (acc, c) => {
      acc.signups += c.signups;
      acc.ftds += c.ftds;
      acc.repeatDepositors += c.repeatDepositors;
      acc.churned += c.churned;
      acc.active += c.active;
      acc.depositsUsd += c.depositsUsd;
      acc.wagerUsd += c.wagerUsd;
      return acc;
    },
    {
      signups: 0,
      ftds: 0,
      repeatDepositors: 0,
      churned: 0,
      active: 0,
      depositsUsd: 0,
      wagerUsd: 0,
    },
  );

  return {
    cohorts,
    totals: {
      ...sum,
      ftdRate: ratio(sum.ftds, sum.signups),
      repeatRate: ratio(sum.repeatDepositors, sum.ftds),
      avgDepositPerFtdUsd: ratio(sum.depositsUsd, sum.ftds),
    },
    lifetimeNetUsd: pnl ? pnl.lifetime.pnl : null,
    lookbackDays: SIGNUP_LOOKBACK_DAYS,
    churnWindowDays: CHURN_WINDOW_DAYS,
  };
}

// 5-minute cross-request cache, prod-pinned — identical mechanics to
// `_pnl-cache.ts`: `unstable_cache` runs outside the request's dynamic scope
// so `cookies()` (and thus the dev/prod toggle) isn't readable inside it; we
// therefore cache ONLY on prod (the default) and run the query directly for a
// dev-toggled admin so they always see live dev data. The cohort scan is
// stable minute-to-minute, so 300s is safe while still surfacing new signups
// promptly.
const REVALIDATE_SECONDS = 300;

const cachedCohorts = unstable_cache(
  (creatorUserId: string): Promise<CohortsData> => queryCohorts(creatorUserId),
  ["creator-hub-cohorts-ltv-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["creator-hub-cohorts-ltv"] },
);

/** Cached on prod; direct (uncached) on a dev-toggled admin — see module doc. */
export async function getCohortsData(
  creatorUserId: string,
): Promise<CohortsData> {
  const env = await readDbEnv();
  if (env !== "prod") return queryCohorts(creatorUserId);
  return cachedCohorts(creatorUserId);
}
