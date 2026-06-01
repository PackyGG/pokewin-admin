import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "../_blacklist";
import { periodSqlInterval, type StreamerPeriod } from "@/app/(admin)/insights/streamers/types";
import type { CreatorInsightRow } from "./types";

/**
 * Per-creator aggregate for the Overview / Money Makers / ROI tabs.
 *
 * Methodology (matches creators-pnl.ts conventions — every column /
 * enum used here is proven against that shipped query and/or
 * prisma/schema.prisma, never guessed):
 *   - Cohort = users referred via this creator's `affiliate_code_usages`
 *     (deduped). Staff (admin/support/creator) + the excluded-users
 *     blacklist are dropped so the counts match /creators/[id].
 *   - cohortWagerUsd      = SUM(acu.wager_amount_usd) WHERE usage_type='wager'.
 *   - cohortDepositsUsd   = SUM(acu.deposit_amount_usd) WHERE usage_type='deposit'.
 *   - commissionAccruedUsd= SUM(acu.referrer_cut_usd) on wager rows.
 *   - payoutSettledUsd    = SUM(affiliate_payouts.amount_usd) WHERE status='paid'.
 *   - cohortCardWithdrawalsUsd = value of cards / session-linked vouchers
 *     that left the house from a session wagered under this creator's
 *     code (the WITHDRAWN_UNITS model from creators-pnl.ts).
 *   - housePnl = cohortDeposits − cohortCardWithdrawals − commissionAccrued.
 *
 * RUNTIME-SAFETY REBUILD (was: one monster $queryRawUnsafe that threw on
 * every non-lifetime period because the card-withdrawal CTE referenced a
 * `cwr` alias that wasn't in scope — `missing FROM-clause entry for
 * table "cwr"`. The default period is 7d, so the whole Overview / Money
 * Makers / ROI surface blanked via the safeQuery fallback). The work is
 * now split into FOUR independent aggregates, each fetched with
 * Promise.allSettled so a single failing sub-query degrades to zeros for
 * that metric instead of taking all three tabs down. Each sub-query is a
 * plain per-creator GROUP BY — no exotic lateral/window constructs.
 *
 * Read-only against the Main DB. Cross-request cached for 5 minutes.
 */

const TTL_SECONDS = 300;

/** Logs a single sub-query failure without taking the page down. */
function logAggregateFailure(name: string, reason: unknown): void {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(
    `[insights-streamers.overview] aggregate '${name}' threw, falling back to zero for every creator: ${msg}`,
  );
}

type CreatorBaseRow = {
  user_id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  primary_code: string | null;
};
type CohortRow = {
  user_id: string;
  referred_count: string;
  active_count: string;
  ftd_count: string;
  cohort_wager: string;
  cohort_deposits: string;
  commission_accrued: string;
};
type CardWdRow = { user_id: string; cohort_cardwd: string };
type PayoutRow = { user_id: string; payout_settled: string };

async function fetchInner(period: StreamerPeriod): Promise<CreatorInsightRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistRu = blacklistNotInClause("ru.id", excluded);

  const interval = periodSqlInterval(period);
  // Period predicates are folded into each sub-query so a creator with
  // no period activity still surfaces with zeros (LEFT JOIN behaviour).
  // Lifetime drops the predicate entirely.
  const acuPeriod = interval ? `AND acu.created_at >= NOW() - ${interval}` : "";
  // FIX: the card-withdrawal window keys off `wu.withdrawn_at`, the
  // column the withdrawn-units sub-select PROJECTS (= COALESCE(shipped_at,
  // completed_at)). The previous code referenced `cwr.shipped_at` here,
  // but no `cwr` alias is in scope in this CTE — that was the throw.
  const wuPeriod = interval ? `AND wu.withdrawn_at >= NOW() - ${interval}` : "";
  const payoutPeriod = interval ? `AND ap.created_at >= NOW() - ${interval}` : "";

  // ── 1. Creator base list (id + identity + primary code) ───────────
  // Independent of every aggregate; drives the LEFT-JOIN-in-TS merge so
  // every creator surfaces even when an aggregate sub-query fails.
  const baseP = db.$queryRawUnsafe<CreatorBaseRow[]>(`
    SELECT u.id AS user_id, u.username, u.email, u.image,
           (SELECT ac.code FROM affiliate_codes ac
             WHERE ac.user_id = u.id
             ORDER BY ac.created_at ASC LIMIT 1) AS primary_code
      FROM "user" u
     WHERE u.role = 'creator'
  `);

  // ── 2. Cohort aggregate (counts + wager + deposits + commission) ──
  // One row per creator. `usage_type` literals verified against the
  // affiliate_usage_type enum (deposit / wager / signup).
  const cohortP = db.$queryRawUnsafe<CohortRow[]>(`
    SELECT acu.affiliate_user_id AS user_id,
           COUNT(DISTINCT acu.referred_user_id) FILTER (
             WHERE acu.usage_type::text = 'signup'
           )::text AS referred_count,
           COUNT(DISTINCT acu.referred_user_id) FILTER (
             WHERE acu.usage_type::text IN ('deposit','wager') ${acuPeriod}
           )::text AS active_count,
           COUNT(DISTINCT acu.referred_user_id) FILTER (
             WHERE acu.usage_type::text = 'deposit'
           )::text AS ftd_count,
           COALESCE(SUM(CASE
             WHEN acu.usage_type::text = 'wager' ${acuPeriod}
               THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS cohort_wager,
           COALESCE(SUM(CASE
             WHEN acu.usage_type::text = 'deposit' ${acuPeriod}
               THEN acu.deposit_amount_usd::numeric ELSE 0 END), 0)::text AS cohort_deposits,
           COALESCE(SUM(CASE
             WHEN acu.usage_type::text = 'wager' ${acuPeriod}
               THEN acu.referrer_cut_usd::numeric ELSE 0 END), 0)::text AS commission_accrued
      FROM affiliate_code_usages acu
      JOIN "user" ru ON ru.id = acu.referred_user_id
     WHERE ru.role NOT IN ('admin', 'support', 'creator')
       ${blacklistRu}
     GROUP BY acu.affiliate_user_id
  `);

  // ── 3. Card withdrawals attributable to the creator's cohort ──────
  // A value-unit (card OR session-linked voucher) counts when its
  // source session was wagered under this creator's code. Same
  // WITHDRAWN_UNITS shape as creators-pnl.ts; the cwr array columns are
  // UNNEST'd inside a sub-select that projects `withdrawn_at`, so the
  // outer CTE never references the `cwr` alias.
  const cardWdP = db.$queryRawUnsafe<CardWdRow[]>(`
    WITH creator_sessions AS (
      SELECT DISTINCT acu.affiliate_user_id, acu.game_session_id
        FROM affiliate_code_usages acu
        JOIN "user" ru ON ru.id = acu.referred_user_id
       WHERE acu.usage_type::text = 'wager'
         AND acu.game_session_id IS NOT NULL
         AND ru.role NOT IN ('admin', 'support', 'creator')
         ${blacklistRu}
    ),
    withdrawn_units AS (
      SELECT cwr_u.withdrawn_at, ui.source_id,
             ui.value_at_obtained::numeric AS value
        FROM (
          SELECT COALESCE(cwr.shipped_at, cwr.completed_at) AS withdrawn_at,
                 UNNEST(cwr.inventory_item_ids) AS item_id
            FROM card_withdrawal_requests cwr
           WHERE cwr.status IN ('completed', 'shipped')
        ) cwr_u
        JOIN user_inventory ui ON ui.id = cwr_u.item_id
       WHERE ui.source_type::text IN ('pack', 'battle')
      UNION ALL
      SELECT cwr_u.withdrawn_at, v.origin_id AS source_id,
             v.value::numeric AS value
        FROM (
          SELECT COALESCE(cwr.shipped_at, cwr.completed_at) AS withdrawn_at,
                 UNNEST(cwr.voucher_ids) AS voucher_id
            FROM card_withdrawal_requests cwr
           WHERE cwr.status IN ('completed', 'shipped')
        ) cwr_u
        JOIN vouchers v ON v.id = cwr_u.voucher_id
       WHERE v.origin::text IN ('battle_excess_to_voucher', 'pack_borrow_to_voucher')
    )
    SELECT cs.affiliate_user_id AS user_id,
           COALESCE(SUM(wu.value), 0)::text AS cohort_cardwd
      FROM creator_sessions cs
      JOIN withdrawn_units wu
        ON wu.source_id = cs.game_session_id
       ${wuPeriod}
     GROUP BY cs.affiliate_user_id
  `);

  // ── 4. Settled affiliate payouts in the window ────────────────────
  // affiliate_payouts has no settlement timestamp, only created_at, so
  // the window keys off created_at (same caveat as the legacy code).
  const payoutP = db.$queryRawUnsafe<PayoutRow[]>(`
    SELECT ap.affiliate_user_id AS user_id,
           COALESCE(SUM(ap.amount_usd::numeric), 0)::text AS payout_settled
      FROM affiliate_payouts ap
     WHERE ap.status::text = 'paid'
       ${payoutPeriod}
     GROUP BY ap.affiliate_user_id
  `);

  // Per-aggregate isolation: the base list is required (it defines the
  // row set); the three metric aggregates each degrade to an empty map
  // on failure so one bad sub-query can't blank all three tabs.
  const [baseRes, cohortRes, cardWdRes, payoutRes] = await Promise.allSettled([
    baseP,
    cohortP,
    cardWdP,
    payoutP,
  ]);

  if (baseRes.status !== "fulfilled") {
    // The base list is the spine of the result — without it there's
    // nothing to render. Re-throw so safeQuery shows the error tile
    // rather than an empty (and misleading) "no creators" table.
    throw baseRes.reason;
  }
  const base = baseRes.value;

  const cohortMap = new Map<string, CohortRow>();
  if (cohortRes.status === "fulfilled") {
    for (const r of cohortRes.value) cohortMap.set(r.user_id, r);
  } else {
    logAggregateFailure("cohort", cohortRes.reason);
  }

  const cardWdMap = new Map<string, number>();
  if (cardWdRes.status === "fulfilled") {
    for (const r of cardWdRes.value) {
      cardWdMap.set(r.user_id, toNumber(r.cohort_cardwd));
    }
  } else {
    logAggregateFailure("card-withdrawals", cardWdRes.reason);
  }

  const payoutMap = new Map<string, number>();
  if (payoutRes.status === "fulfilled") {
    for (const r of payoutRes.value) {
      payoutMap.set(r.user_id, toNumber(r.payout_settled));
    }
  } else {
    logAggregateFailure("payouts", payoutRes.reason);
  }

  const rows: CreatorInsightRow[] = base.map((b) => {
    const co = cohortMap.get(b.user_id);
    const cohortDeposits = co ? toNumber(co.cohort_deposits) : 0;
    const cohortCardWd = cardWdMap.get(b.user_id) ?? 0;
    const commissionAccrued = co ? toNumber(co.commission_accrued) : 0;
    const housePnl = cohortDeposits - cohortCardWd - commissionAccrued;
    const houseRoi = commissionAccrued > 0 ? housePnl / commissionAccrued : null;
    return {
      userId: b.user_id,
      username: b.username,
      email: b.email,
      image: b.image,
      primaryCode: b.primary_code,
      referredCount: co ? Number(co.referred_count) : 0,
      activeReferredCount: co ? Number(co.active_count) : 0,
      ftdReferredCount: co ? Number(co.ftd_count) : 0,
      cohortWagerUsd: co ? toNumber(co.cohort_wager) : 0,
      cohortDepositsUsd: cohortDeposits,
      cohortCardWithdrawalsUsd: cohortCardWd,
      commissionAccruedUsd: commissionAccrued,
      payoutSettledUsd: payoutMap.get(b.user_id) ?? 0,
      housePnl,
      houseRoi,
    };
  });

  // Sort by house P&L descending — same order the table renders.
  rows.sort((a, b) => b.housePnl - a.housePnl);
  return rows;
}

const cached = unstable_cache(
  fetchInner,
  // v2: split the monster query into isolated aggregates + fixed the
  // cwr-alias throw that blanked the tab on every non-lifetime period.
  ["insights-streamers-overview-v2"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getStreamerInsightRows(period: StreamerPeriod) {
  return cached(period);
}
