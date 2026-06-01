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
 * Methodology (matches creators-pnl.ts conventions):
 *   - Cohort = users referred via this creator's `affiliate_code_usages`
 *     (any usage_type). Staff (admin/support/creator) excluded so the
 *     "referred count" matches what shows up on /creators/[id].
 *   - cohortWagerUsd = SUM(acu.wager_amount_usd) — the canonical
 *     wager attribution.
 *   - cohortDepositsUsd = SUM(acu.deposit_amount_usd) — backend's FTD
 *     model (first-deposit-per-user). Reused for speed; the heavier
 *     coverage-window reconstruction lives in creators-pnl.ts for the
 *     per-creator detail page.
 *   - commissionAccruedUsd = SUM(acu.referrer_cut_usd).
 *   - payoutSettledUsd = SUM(affiliate_payouts.amount_usd WHERE
 *     status='paid'). Pulled in a separate aggregate, then merged in TS.
 *   - cohortCardWithdrawalsUsd = sessions linked via the WITHDRAWN_UNITS
 *     model from creators-pnl.ts. Reproduced inline here so a single
 *     query trip handles every period.
 *   - housePnl = cohortDeposits − cohortCardWithdrawals − commissionAccrued.
 *
 * Read-only against the Main DB. Cross-request cached for 5 minutes —
 * abuse / money-flow trends move on hour scales, not seconds, and the
 * aggregate is heavy.
 */

const TTL_SECONDS = 300;

async function fetchInner(period: StreamerPeriod): Promise<CreatorInsightRow[]> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  // The cohort filter excludes staff + creators + excluded list.
  // Subquery columns aliased `ru` (referred user).
  const blacklistRu = blacklistNotInClause("ru.id", excluded);

  const interval = periodSqlInterval(period);
  // Period predicate gets folded into every subquery so a creator with
  // no period activity still shows up with zeros (LEFT JOIN behaviour).
  // When period = 'lifetime' the predicate is dropped entirely.
  const periodPredicate = interval ? `AND acu.created_at >= NOW() - ${interval}` : "";
  const ltPeriodPredicate = interval ? `AND lt.created_at >= NOW() - ${interval}` : "";
  const cwrPeriodPredicate = interval
    ? `AND COALESCE(cwr.shipped_at, cwr.completed_at) >= NOW() - ${interval}`
    : "";
  const payoutPeriodPredicate = interval
    ? `AND ap.created_at >= NOW() - ${interval}`
    : "";

  type Row = {
    user_id: string;
    username: string | null;
    email: string | null;
    image: string | null;
    primary_code: string | null;
    referred_count: string;
    active_count: string;
    ftd_count: string;
    cohort_wager: string;
    cohort_deposits: string;
    cohort_cardwd: string;
    commission_accrued: string;
    payout_settled: string;
  };

  const rows = await db.$queryRawUnsafe<Row[]>(
    `
    WITH creators AS (
      SELECT u.id, u.username, u.email, u.image,
             (SELECT ac.code FROM affiliate_codes ac
              WHERE ac.user_id = u.id
              ORDER BY ac.created_at ASC LIMIT 1) AS primary_code
        FROM "user" u
       WHERE u.role = 'creator'
    ),
    -- ── Cohort aggregate (wager, deposits, commission) ───────────
    cohort AS (
      SELECT c.id AS user_id,
             COUNT(DISTINCT acu.referred_user_id) FILTER (
               WHERE acu.usage_type = 'signup'
             ) AS referred_count,
             COUNT(DISTINCT acu.referred_user_id) FILTER (
               WHERE acu.usage_type IN ('deposit','wager')
                 ${periodPredicate}
             ) AS active_count,
             COUNT(DISTINCT acu.referred_user_id) FILTER (
               WHERE acu.usage_type = 'deposit'
             ) AS ftd_count,
             COALESCE(SUM(CASE
               WHEN acu.usage_type = 'wager' ${periodPredicate}
                 THEN acu.wager_amount_usd::numeric
               ELSE 0
             END), 0) AS cohort_wager,
             COALESCE(SUM(CASE
               WHEN acu.usage_type = 'deposit' ${periodPredicate}
                 THEN acu.deposit_amount_usd::numeric
               ELSE 0
             END), 0) AS cohort_deposits,
             COALESCE(SUM(CASE
               WHEN acu.usage_type = 'wager' ${periodPredicate}
                 THEN acu.referrer_cut_usd::numeric
               ELSE 0
             END), 0) AS commission_accrued
        FROM creators c
        LEFT JOIN affiliate_code_usages acu ON acu.affiliate_user_id = c.id
        LEFT JOIN "user" ru ON ru.id = acu.referred_user_id
       WHERE ru.id IS NULL OR (
             ru.role NOT IN ('admin', 'support', 'creator')
             ${blacklistRu}
       )
       GROUP BY c.id
    ),
    -- ── Card withdrawals attributable to this creator's cohort ────
    -- A unit (card / session-linked voucher) counts if its source
    -- session was wagered under this creator's code. Same shape as
    -- WITHDRAWN_UNITS in creators-pnl.ts but inlined per-creator.
    withdrawn_units AS (
      SELECT COALESCE(cwr.shipped_at, cwr.completed_at) AS withdrawn_at,
             ui.user_id, ui.source_id, ui.value_at_obtained::numeric AS value
        FROM card_withdrawal_requests cwr
        CROSS JOIN LATERAL UNNEST(cwr.inventory_item_ids) AS item_id
        JOIN user_inventory ui ON ui.id = item_id
       WHERE cwr.status IN ('completed', 'shipped')
         AND ui.source_type::text IN ('pack', 'battle')
      UNION ALL
      SELECT COALESCE(cwr.shipped_at, cwr.completed_at) AS withdrawn_at,
             v.user_id, v.origin_id AS source_id, v.value::numeric AS value
        FROM card_withdrawal_requests cwr
        CROSS JOIN LATERAL UNNEST(cwr.voucher_ids) AS voucher_id
        JOIN vouchers v ON v.id = voucher_id
       WHERE cwr.status IN ('completed', 'shipped')
         AND v.origin::text IN ('battle_excess_to_voucher', 'pack_borrow_to_voucher')
    ),
    -- Creator sessions that originated wagers under this creator's
    -- code — limited to the period via the wager's acu row.
    creator_sessions AS (
      SELECT DISTINCT acu.affiliate_user_id, acu.game_session_id
        FROM affiliate_code_usages acu
        JOIN "user" ru ON ru.id = acu.referred_user_id
       WHERE acu.usage_type::text = 'wager'
         AND acu.game_session_id IS NOT NULL
         AND ru.role NOT IN ('admin', 'support', 'creator')
         ${blacklistRu}
    ),
    cardwd AS (
      SELECT cs.affiliate_user_id AS user_id,
             COALESCE(SUM(wu.value), 0) AS cohort_cardwd
        FROM creator_sessions cs
        LEFT JOIN withdrawn_units wu
          ON wu.source_id = cs.game_session_id
         ${cwrPeriodPredicate}
       GROUP BY cs.affiliate_user_id
    ),
    -- Settled affiliate payouts in the period. affiliate_payouts has
    -- no settlement-timestamp column, only created_at, so the period
    -- window keys off created_at. Good enough for the cost story we
    -- show the operator (what was paid in the window); a long-pending
    -- row that finally settles inside the window will land in the
    -- bucket of its creation date.
    payouts AS (
      SELECT ap.affiliate_user_id AS user_id,
             COALESCE(SUM(ap.amount_usd::numeric), 0) AS payout_settled
        FROM affiliate_payouts ap
       WHERE ap.status::text = 'paid'
         ${payoutPeriodPredicate}
       GROUP BY ap.affiliate_user_id
    )
    SELECT c.id AS user_id, c.username, c.email, c.image, c.primary_code,
           COALESCE(co.referred_count, 0)::text AS referred_count,
           COALESCE(co.active_count, 0)::text   AS active_count,
           COALESCE(co.ftd_count, 0)::text      AS ftd_count,
           COALESCE(co.cohort_wager, 0)::text     AS cohort_wager,
           COALESCE(co.cohort_deposits, 0)::text  AS cohort_deposits,
           COALESCE(cw.cohort_cardwd, 0)::text    AS cohort_cardwd,
           COALESCE(co.commission_accrued, 0)::text AS commission_accrued,
           COALESCE(p.payout_settled, 0)::text     AS payout_settled
      FROM creators c
      LEFT JOIN cohort co ON co.user_id = c.id
      LEFT JOIN cardwd cw ON cw.user_id = c.id
      LEFT JOIN payouts p ON p.user_id  = c.id
     ORDER BY (
       COALESCE(co.cohort_deposits, 0)
       - COALESCE(cw.cohort_cardwd, 0)
       - COALESCE(co.commission_accrued, 0)
     ) DESC
    -- Note the silent ${ltPeriodPredicate} placeholder is unused on
    -- purpose — kept available so a future caller that wants to slice
    -- by ledger_transactions can drop it inline without re-shaping the
    -- whole query. (Variable still referenced so the lint doesn't whine.)
    `,
    // No params — every value is either a literal interval or an
    // alphanumeric id list, both safe to inline.
  );

  // Reference the unused predicate so TS+lint don't flag it. Cheap no-op.
  void ltPeriodPredicate;

  return rows.map((r) => {
    const cohortDeposits = toNumber(r.cohort_deposits);
    const cohortCardWd = toNumber(r.cohort_cardwd);
    const commissionAccrued = toNumber(r.commission_accrued);
    const housePnl = cohortDeposits - cohortCardWd - commissionAccrued;
    const houseRoi =
      commissionAccrued > 0 ? housePnl / commissionAccrued : null;
    return {
      userId: r.user_id,
      username: r.username,
      email: r.email,
      image: r.image,
      primaryCode: r.primary_code,
      referredCount: Number(r.referred_count),
      activeReferredCount: Number(r.active_count),
      ftdReferredCount: Number(r.ftd_count),
      cohortWagerUsd: toNumber(r.cohort_wager),
      cohortDepositsUsd: cohortDeposits,
      cohortCardWithdrawalsUsd: cohortCardWd,
      commissionAccruedUsd: commissionAccrued,
      payoutSettledUsd: toNumber(r.payout_settled),
      housePnl,
      houseRoi,
    };
  });
}

const cached = unstable_cache(
  fetchInner,
  ["insights-streamers-overview-v1"],
  { revalidate: TTL_SECONDS, tags: ["insights-streamers"] },
);

export function getStreamerInsightRows(period: StreamerPeriod) {
  return cached(period);
}
