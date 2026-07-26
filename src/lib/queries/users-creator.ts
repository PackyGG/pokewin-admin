import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export async function getCreatorReferralClicks(
  affiliateCode: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<{
  id: number;
  code: string;
  userAgent: string | null;
  ip: string;
  country: string;
  region: string;
  city: string;
  createdAt: string | null;
}>> {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(
    200,
    Math.max(1, Math.trunc(perPage) || 20),
  );
  const clicks = await queryMainRows<
    {
      id: number | null;
      code: string | null;
      user_agent: string | null;
      ip: string;
      country: string;
      region: string;
      city: string;
      created_at: Date | null;
      total_count: string;
    }[]
  >(
    `WITH filtered AS MATERIALIZED (
       SELECT id, code, user_agent, ip, country, region, city, created_at
         FROM affiliate_clicks
        WHERE code = $1
     )
     SELECT page.*, totals.total_count
       FROM (SELECT COUNT(*)::text AS total_count FROM filtered) totals
       LEFT JOIN LATERAL (
         SELECT *
           FROM filtered
          ORDER BY created_at DESC
          OFFSET $2 LIMIT $3
       ) page ON TRUE`,
    affiliateCode,
    (safePage - 1) * safePerPage,
    safePerPage,
  );
  const total = Number(clicks[0]?.total_count ?? 0);

  return {
    data: clicks
      .filter((c): c is typeof c & { id: number } => c.id !== null)
      .map((c) => ({
      id: c.id,
      code: c.code ?? affiliateCode,
      userAgent: c.user_agent,
      ip: c.ip,
      country: c.country,
      region: c.region,
      city: c.city,
      createdAt: c.created_at?.toISOString() ?? null,
      })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

export async function getCreatorCodeUsages(
  userId: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<{
  id: string;
  referredUserId: string;
  referredUsername: string | null;
  usageType: string;
  depositAmountUsd: number;
  wagerAmountUsd: number;
  referrerCutUsd: number;
  userBonusUsd: number;
  createdAt: string;
}>> {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(
    200,
    Math.max(1, Math.trunc(perPage) || 20),
  );
  const usages = await queryMainRows<
    {
      id: string | null;
      referred_user_id: string | null;
      referred_username: string | null;
      usage_type: string;
      deposit_amount_usd: string;
      wager_amount_usd: string;
      referrer_cut_usd: string;
      user_bonus_usd: string;
      created_at: Date;
      total_count: string;
    }[]
  >(
    `WITH filtered AS MATERIALIZED (
       SELECT acu.id, acu.referred_user_id,
              COALESCE(u.username, u.email) AS referred_username,
              acu.usage_type::text AS usage_type,
              acu.deposit_amount_usd::text AS deposit_amount_usd,
              acu.wager_amount_usd::text AS wager_amount_usd,
              acu.referrer_cut_usd::text AS referrer_cut_usd,
              acu.user_bonus_usd::text AS user_bonus_usd,
              acu.created_at
         FROM affiliate_code_usages acu
         LEFT JOIN "user" u ON u.id = acu.referred_user_id
        WHERE acu.affiliate_user_id = $1
     )
     SELECT page.*, totals.total_count
       FROM (SELECT COUNT(*)::text AS total_count FROM filtered) totals
       LEFT JOIN LATERAL (
         SELECT *
           FROM filtered
          ORDER BY created_at DESC
          OFFSET $2 LIMIT $3
       ) page ON TRUE`,
    userId,
    (safePage - 1) * safePerPage,
    safePerPage,
  );
  const total = Number(usages[0]?.total_count ?? 0);

  return {
    data: usages
      .filter(
        (u): u is typeof u & { id: string; referred_user_id: string } =>
          u.id !== null && u.referred_user_id !== null,
      )
      .map((u) => ({
      id: u.id,
      referredUserId: u.referred_user_id,
      referredUsername: u.referred_username,
      usageType: u.usage_type,
      depositAmountUsd: toNumber(u.deposit_amount_usd),
      wagerAmountUsd: toNumber(u.wager_amount_usd),
      referrerCutUsd: toNumber(u.referrer_cut_usd),
      userBonusUsd: toNumber(u.user_bonus_usd),
      createdAt: u.created_at.toISOString(),
      })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * One referred user's full ATTRIBUTION JOURNEY — the affiliate / creator
 * codes THIS user has passed through over time (the "code-hopping"
 * history), with the economics booked under each code.
 *
 * ── DATA SOURCE (canonical, same as the creators surfaces) ──────────────
 * `affiliate_code_usages` (acu) is the single source of truth for
 * code↔player attribution. The backend writes acu rows while a code is
 * active for the user, scoped here to `referred_user_id = userId`:
 *   • `deposit_amount_usd` — deposit booked under the code (the SAME
 *     column `/creators/[id]`'s deposit attribution reads).
 *   • `wager_amount_usd`   — wager booked under the code (the SAME column
 *     `getCodeAndWagerByUser` / the code-hopper signal read).
 * So the per-code deposits + wager here reconcile by construction with how
 * the creators page attributes them — we just GROUP the same rows by code
 * for one user instead of by creator across many.
 *
 * Grouping is on `UPPER(code)` — the exact normalisation the code-hopper
 * detector (`code-hopper-flags.ts`) uses — so casing variants of the same
 * code collapse into one journey entry. The display code is the
 * most-recently-seen spelling. `affiliate_user_id` (the creator who owns
 * the code) is carried per group so the row can link to the creator and
 * label whose code it was; it's stable per code.
 *
 * Ordering is CHRONOLOGICAL by first-used so the journey reads top-to-
 * bottom as the user actually hopped (e.g. creator1 → creator2). Each row
 * also carries last-used + a usage count so an admin can see how long the
 * user stayed on each code.
 *
 * `usage_type` is cast to `::text` for the same `22P02`-hardening the
 * other acu queries use. The scan is bounded to a 365-day lookback —
 * matching `LIFETIME_LOOKBACK_DAYS` in `creators-pnl.ts` — so it never
 * degrades into a full-history acu scan (the affiliate program is recent
 * enough that this covers all real attributed activity). Read-only,
 * Main DB.
 */
export type AttributionJourneyEntry = {
  /** Display spelling of the code (most-recently-seen casing). */
  code: string;
  /** user_id of the creator who owns this code. */
  creatorUserId: string;
  /** Creator username/email for the link label, null if unresolved. */
  creatorName: string | null;
  /** First acu row under this code for the user (ISO) — when they hopped on. */
  firstUsedAt: string;
  /** Most-recent acu row under this code (ISO) — when they last touched it. */
  lastUsedAt: string;
  /**
   * Most-recent date this specific code was actually APPLIED to the user —
   * MAX(created_at) of the `signup` (attribution) acu rows under the code,
   * as opposed to `lastUsedAt` which is dominated by the user's later
   * deposit/wager activity. NULL when no `signup` row exists for the code
   * (e.g. an admin-injected code, which writes a `deposit`-type row).
   */
  lastAppliedAt: string | null;
  /** Deposits booked under this code — Σ acu.deposit_amount_usd. */
  depositAmountUsd: number;
  /** Wager booked under this code — Σ acu.wager_amount_usd. */
  wagerAmountUsd: number;
  /** acu rows under this code (deposit + wager + signup) — engagement depth. */
  usageCount: number;
};

type AttributionJourneyRow = {
  code: string;
  affiliate_user_id: string;
  creator_name: string | null;
  first_used_at: Date;
  last_used_at: Date;
  last_applied_at: Date | null;
  deposit_total: string;
  wager_total: string;
  usage_count: string;
};

// Same lifetime guard the creator P&L lifetime aggregate uses — keeps the
// acu scan bounded instead of walking the full attribution history.
const ATTRIBUTION_LOOKBACK_DAYS = 365;

export async function getUserAttributionJourney(
  userId: string,
): Promise<AttributionJourneyEntry[]> {

  // One grouped scan over the user's acu rows. DISTINCT-ON-style picks of
  // the latest-seen code spelling + owning creator are done with
  // (array_agg ... ORDER BY created_at DESC)[1] so a single GROUP BY on
  // UPPER(code) yields both the aggregates and the representative labels.
  const rows = await queryMainRows<AttributionJourneyRow[]>(
    `SELECT (array_agg(acu.code ORDER BY acu.created_at DESC))[1] AS code,
            (array_agg(acu.affiliate_user_id ORDER BY acu.created_at DESC))[1] AS affiliate_user_id,
            (array_agg(COALESCE(u.username, u.email) ORDER BY acu.created_at DESC))[1] AS creator_name,
            MIN(acu.created_at) AS first_used_at,
            MAX(acu.created_at) AS last_used_at,
            MAX(acu.created_at) FILTER (WHERE acu.usage_type::text = 'signup') AS last_applied_at,
            COALESCE(SUM(acu.deposit_amount_usd::numeric), 0)::text AS deposit_total,
            COALESCE(SUM(acu.wager_amount_usd::numeric), 0)::text AS wager_total,
            COUNT(*)::text AS usage_count
       FROM affiliate_code_usages acu
       LEFT JOIN "user" u ON u.id = acu.affiliate_user_id
      WHERE acu.referred_user_id = $1
        AND acu.usage_type::text IN ('deposit', 'wager', 'signup')
        AND acu.created_at >= NOW() - INTERVAL '${ATTRIBUTION_LOOKBACK_DAYS} days'
      GROUP BY UPPER(acu.code)
      ORDER BY MIN(acu.created_at) ASC`,
    userId,
  );

  return rows.map((r) => ({
    code: r.code,
    creatorUserId: r.affiliate_user_id,
    creatorName: r.creator_name,
    firstUsedAt: r.first_used_at.toISOString(),
    lastUsedAt: r.last_used_at.toISOString(),
    lastAppliedAt: r.last_applied_at ? r.last_applied_at.toISOString() : null,
    depositAmountUsd: toNumber(r.deposit_total),
    wagerAmountUsd: toNumber(r.wager_total),
    usageCount: Number(r.usage_count),
  }));
}

export async function getCreatorWithdrawalLimits(userId: string) {
  const [limits] = await queryMainRows<
    {
      currency_limit_amount: string | null;
      currency_limit_start_date: Date | null;
      currency_limit_reset_days: number | null;
      percentage_limit: string | null;
    }[]
  >(
    `SELECT currency_limit_amount::text AS currency_limit_amount,
            currency_limit_start_date,
            currency_limit_reset_days,
            percentage_limit::text AS percentage_limit
       FROM creator_withdrawal_limits
      WHERE user_id = $1
      LIMIT 1`,
    userId,
  );
  if (!limits) return null;
  return {
    currencyLimitAmount: limits.currency_limit_amount ? toNumber(limits.currency_limit_amount) : null,
    currencyLimitStartDate: limits.currency_limit_start_date?.toISOString() ?? null,
    currencyLimitResetDays: limits.currency_limit_reset_days,
    percentageLimit: limits.percentage_limit ? toNumber(limits.percentage_limit) : null,
  };
}
