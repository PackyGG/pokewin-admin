import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { MS_PER_DAY } from "@/lib/utils/time";

/**
 * Queries for the /creators/ads feature. Ad codes are plain
 * `affiliate_codes` rows owned by a single "house" user that the admin
 * designates via the admin_settings table. Everything else — clicks,
 * signups, depositor usages — already flows through the existing
 * affiliate infrastructure.
 *
 * Signup tracking source-of-truth: `affiliate_code_usages` rows where
 * `usage_type = 'signup'`. This is the canonical, transactional record
 * the backend writes alongside `user.referred_by`. We previously read
 * signups off `user.referred_by + user.affiliate_code`, which silently
 * undercounted whenever the recordSignupUsage hook had failed (we found
 * ~28 such cases historically). Reading from `affiliate_code_usages`
 * keeps this page aligned with /creators/codes/[code] and the wider
 * affiliate dashboard.
 *
 * Code casing: affiliate_clicks is always uppercase (trackClick
 * normalises). affiliate_codes/usages store mixed casing for legacy
 * rows. Every query here therefore matches case-insensitively
 * (UPPER/LOWER on both sides) so a code that landed lowercase in one
 * table still aligns with its uppercase sibling in another.
 */

// Production schema occasionally lags behind dev — when a missing
// table/column would otherwise crash the page, fall back to an empty
// result so the layout still renders. Errors are still logged so we
// notice silent regressions instead of acting on partial data forever.
async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    console.error("[ads] query failed, using fallback:", err);
    return fallback;
  }
}

export type AdCodeSummary = {
  code: string;
  createdAt: string;
  clicks: number;
  signups: number;
  /** Signed-up users on this code who later deposited or wagered. */
  activeReferrals: number;
  /** Unique users who made any deposit attributed to this code (from ledger). */
  depositors: number;
  /** Total number of deposit events booked to this code (from ledger). */
  depositEventCount: number;
  /** Real deposit volume on this code, summed from ledger.deposit_bonus events. */
  depositVolumeUsd: number;
  /** First-time deposit volume only (from affiliate_code_usages, FTD-gated by backend). */
  ftdVolumeUsd: number;
  wagerVolumeUsd: number;
  /** signups / clicks (0-1). 0 when no clicks yet. */
  conversionRate: number;
};

export type AdAggregate = {
  totalCodes: number;
  totalClicks: number;
  totalSignups: number;
  totalActiveReferrals: number;
  totalDepositors: number;
  totalDepositEventCount: number;
  totalDepositVolumeUsd: number;
  totalFtdVolumeUsd: number;
  totalWagerVolumeUsd: number;
};

export type AdCodeClicksByDay = { date: string; clicks: number };
export type AdCodeClicksByCountry = { country: string; clicks: number };

export type AdCodeSignup = {
  userId: string;
  username: string | null;
  email: string | null;
  createdAt: string;
  totalDepositedUsd: number;
  /**
   * balances.total_wagered for this user — surfaces how much each
   * referred user has bet, so admins can answer "where did the
   * code's wager volume come from?" by reading the signups table.
   */
  totalWageredUsd: number;
  isFtd: boolean;
};

/**
 * One row per user who has ever interacted with the code in any way
 * (signup, deposit, wager, etc.), aggregated across every
 * `affiliate_code_usages` row for that (code, user) pair. Surfaces
 * the per-row attribution (what the BACKEND credits to this code)
 * alongside the user's lifetime numbers (so admins can spot
 * mismatches and see who's actually moving the wager volume).
 */
export type AdCodeUsageEntry = {
  userId: string;
  username: string | null;
  email: string | null;
  /** Number of affiliate_code_usages rows for this (code, user). */
  usageCount: number;
  /** Distinct usage_type values observed on this (code, user). */
  usageTypes: string[];
  /** SUM(acu.wager_amount_usd) — wager attributed by the backend. */
  attributedWagerUsd: number;
  /** SUM(acu.deposit_amount_usd) — deposit attributed by the backend. */
  attributedDepositUsd: number;
  /** balances.total_wagered for the user — lifetime, all sources. */
  lifetimeWageredUsd: number;
  /** balances.total_won for the user — what the platform paid them
   *  back in winnings (lifetime). House paid this out → rose. */
  lifetimeWonUsd: number;
  /** balances.total_deposited for the user — lifetime, all sources. */
  lifetimeDepositedUsd: number;
  firstUsedAt: string;
  lastUsedAt: string;
};

export type AdCodeDetail = {
  code: string;
  createdAt: string;
  summary: AdCodeSummary;
  clicksByDay: AdCodeClicksByDay[];
  clicksByCountry: AdCodeClicksByCountry[];
  signupsList: AdCodeSignup[];
  /**
   * Every user who has ever used this code, in any usage_type,
   * sorted by attributed wager DESC. Answers "where is the code's
   * wager volume coming from?" — a row with $250 attributed wager
   * shows up at the top with the user's id, name, and lifetime
   * numbers for context.
   */
  usageHistory: AdCodeUsageEntry[];
};

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Returns a summary row for every affiliate code owned by the house user.
 * Signups are scoped to the specific ad code (user.referred_by =
 * houseUserId AND user.affiliate_code = code) so one code getting
 * traffic doesn't inflate another code's count.
 */
export async function getAdCodes(houseUserId: string): Promise<AdCodeSummary[]> {
  const db = await getDb();
  const codes = await safe(
    db.affiliate_codes.findMany({
      where: { user_id: houseUserId },
      select: { code: true, created_at: true },
      orderBy: { created_at: "desc" },
    }),
    [] as { code: string; created_at: Date }[],
  );
  if (codes.length === 0) return [];

  const codeList = codes.map((c) => c.code);
  const upperCodeList = codeList.map((c) => c.toUpperCase());

  // All per-code aggregates run in parallel. Every match is
  // UPPER(...) = UPPER(...) so a mixed-case `affiliate_codes` row still
  // matches the always-uppercase clicks and the mixed-case usages rows.
  const [
    clickRowsRaw,
    usageRows,
    activeRows,
    ledgerRows,
  ] = await Promise.all([
    safe(
      db.$queryRawUnsafe<{ code_upper: string; count: string }[]>(
        `SELECT UPPER(code) AS code_upper, COUNT(*)::text AS count
           FROM affiliate_clicks
          WHERE UPPER(code) = ANY($1::text[])
          GROUP BY UPPER(code)`,
        upperCodeList,
      ),
      [] as { code_upper: string; count: string }[],
    ),
    // Single batched aggregate against affiliate_code_usages. Replaces
    // three separate round-trips (signup count, deposit-volume sums,
    // depositor count) — same outer filter and same index, so collapsing
    // into one scan with FILTER clauses is strictly cheaper.
    //  - signups        = DISTINCT users with usage_type='signup'
    //  - deposit_total  = SUM(deposit_amount_usd) regardless of usage_type
    //  - wager_total    = SUM(wager_amount_usd)   regardless of usage_type
    //  - depositors_ftd = DISTINCT users with usage_type='deposit'
    safe(
      db.$queryRawUnsafe<{
        code_upper: string;
        signups: string;
        deposit_total: string;
        wager_total: string;
        depositors_ftd: string;
      }[]>(
        `SELECT UPPER(code) AS code_upper,
                COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type = 'signup')::text   AS signups,
                COALESCE(SUM(deposit_amount_usd::numeric), 0)::text                           AS deposit_total,
                COALESCE(SUM(wager_amount_usd::numeric), 0)::text                             AS wager_total,
                COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type = 'deposit')::text  AS depositors_ftd
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = ANY($2::text[])
          GROUP BY UPPER(code)`,
        houseUserId,
        upperCodeList,
      ),
      [] as {
        code_upper: string;
        signups: string;
        deposit_total: string;
        wager_total: string;
        depositors_ftd: string;
      }[],
    ),
    // Active referrals — signed-up users who also generated deposit or
    // wager activity on the same code. Kept separate because it requires
    // a self-join / EXISTS that doesn't combine cleanly with the simple
    // grouped aggregates above.
    safe(
      db.$queryRawUnsafe<{ code_upper: string; count: string }[]>(
        `SELECT UPPER(s.code) AS code_upper,
                COUNT(DISTINCT s.referred_user_id)::text AS count
           FROM affiliate_code_usages s
          WHERE s.affiliate_user_id = $1
            AND UPPER(s.code) = ANY($2::text[])
            AND s.usage_type = 'signup'
            AND EXISTS (
              SELECT 1 FROM affiliate_code_usages a
              WHERE a.referred_user_id = s.referred_user_id
                AND UPPER(a.code) = UPPER(s.code)
                AND a.usage_type IN ('deposit', 'wager')
            )
          GROUP BY UPPER(s.code)`,
        houseUserId,
        upperCodeList,
      ),
      [] as { code_upper: string; count: string }[],
    ),
    // Real deposit volume + counts from ledger.deposit_bonus, grouped
    // by metadata.affiliate_code. Backend writes one bonus row per
    // deposit (not just FTD), so this captures the full economic
    // contribution of each ad code.
    //  - real_volume     = SUM of deposit_usd (every deposit booked here)
    //  - real_depositors = DISTINCT users behind those events
    //  - event_count     = total number of deposit events on this code
    safe(
      db.$queryRawUnsafe<{
        code_upper: string;
        real_volume: string;
        real_depositors: string;
        event_count: string;
      }[]>(
        `SELECT UPPER(metadata->>'affiliate_code') AS code_upper,
                COALESCE(SUM((metadata->>'deposit_usd')::numeric), 0)::text AS real_volume,
                COUNT(DISTINCT user_id)::text AS real_depositors,
                COUNT(*)::text AS event_count
           FROM ledger_transactions
          WHERE type::text = 'deposit_bonus'
            AND UPPER(metadata->>'affiliate_code') = ANY($1::text[])
          GROUP BY UPPER(metadata->>'affiliate_code')`,
        upperCodeList,
      ),
      [] as {
        code_upper: string;
        real_volume: string;
        real_depositors: string;
        event_count: string;
      }[],
    ),
  ]);

  const clickMap = new Map(
    clickRowsRaw.map((r) => [r.code_upper, Number(r.count)]),
  );
  const signupMap = new Map(
    usageRows.map((r) => [r.code_upper, Number(r.signups)]),
  );
  const activeMap = new Map(
    activeRows.map((r) => [r.code_upper, Number(r.count)]),
  );
  const usageMap = new Map(
    usageRows.map((r) => [
      r.code_upper,
      { deposit: toNumber(r.deposit_total), wager: toNumber(r.wager_total) },
    ]),
  );
  const ftdDepositorMap = new Map(
    usageRows.map((r) => [r.code_upper, Number(r.depositors_ftd)]),
  );
  const ledgerMap = new Map(
    ledgerRows.map((r) => [
      r.code_upper,
      {
        volume: toNumber(r.real_volume),
        depositors: Number(r.real_depositors),
        events: Number(r.event_count),
      },
    ]),
  );

  return codes.map((c) => {
    const key = c.code.toUpperCase();
    const clicks = clickMap.get(key) ?? 0;
    const signups = signupMap.get(key) ?? 0;
    const activeReferrals = activeMap.get(key) ?? 0;
    const usage = usageMap.get(key) ?? { deposit: 0, wager: 0 };
    const ledger = ledgerMap.get(key) ?? { volume: 0, depositors: 0, events: 0 };
    // Prefer ledger numbers (every deposit booked) over the FTD-only
    // affiliate_code_usages count. ftdVolumeUsd is kept in the summary
    // alongside it so the UI can still show the FTD slice when needed.
    const depositors = ledger.depositors || ftdDepositorMap.get(key) || 0;
    return {
      code: c.code,
      createdAt: c.created_at.toISOString(),
      clicks,
      signups,
      activeReferrals,
      depositors,
      depositEventCount: ledger.events,
      depositVolumeUsd: ledger.volume,
      ftdVolumeUsd: usage.deposit,
      wagerVolumeUsd: usage.wager,
      conversionRate: clicks > 0 ? signups / clicks : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export async function getAdCodesAggregate(
  houseUserId: string,
): Promise<AdAggregate> {
  const db = await getDb();
  const codeRows = await safe(
    db.affiliate_codes.findMany({
      where: { user_id: houseUserId },
      select: { code: true },
    }),
    [] as { code: string }[],
  );
  const codeList = codeRows.map((c) => c.code);
  const totalCodes = codeList.length;

  if (totalCodes === 0) {
    return {
      totalCodes: 0,
      totalClicks: 0,
      totalSignups: 0,
      totalActiveReferrals: 0,
      totalDepositors: 0,
      totalDepositEventCount: 0,
      totalDepositVolumeUsd: 0,
      totalFtdVolumeUsd: 0,
      totalWagerVolumeUsd: 0,
    };
  }

  const upperCodeList = codeList.map((c) => c.toUpperCase());

  const [clicksRow, usageAggRow, activeRow, ledgerRow] =
    await Promise.all([
      safe(
        db.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(*)::text AS count
             FROM affiliate_clicks
            WHERE UPPER(code) = ANY($1::text[])`,
          upperCodeList,
        ),
        [] as { count: string }[],
      ),
      // Single batched aggregate against affiliate_code_usages. Replaces
      // 3 separate aggregate round-trips (signups distinct, FTD deposit
      // distinct, deposit/wager sums) with one scan and FILTER clauses —
      // same source of truth as the per-code list above so totals stay
      // aligned across pages.
      safe(
        db.$queryRawUnsafe<{
          signups: string;
          depositors_ftd: string;
          deposit: string;
          wager: string;
        }[]>(
          `SELECT
              COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type = 'signup')::text  AS signups,
              COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type = 'deposit')::text AS depositors_ftd,
              COALESCE(SUM(deposit_amount_usd::numeric), 0)::text                          AS deposit,
              COALESCE(SUM(wager_amount_usd::numeric),   0)::text                          AS wager
             FROM affiliate_code_usages
            WHERE affiliate_user_id = $1
              AND UPPER(code) = ANY($2::text[])`,
          houseUserId,
          upperCodeList,
        ),
        [] as {
          signups: string;
          depositors_ftd: string;
          deposit: string;
          wager: string;
        }[],
      ),
      safe(
        db.$queryRawUnsafe<{ count: string }[]>(
          `SELECT COUNT(DISTINCT s.referred_user_id)::text AS count
             FROM affiliate_code_usages s
            WHERE s.affiliate_user_id = $1
              AND UPPER(s.code) = ANY($2::text[])
              AND s.usage_type = 'signup'
              AND EXISTS (
                SELECT 1 FROM affiliate_code_usages a
                WHERE a.referred_user_id = s.referred_user_id
                  AND UPPER(a.code) = UPPER(s.code)
                  AND a.usage_type IN ('deposit', 'wager')
              )`,
          houseUserId,
          upperCodeList,
        ),
        [] as { count: string }[],
      ),
      // Real deposit volume + counts from ledger across every ad code
      // owned by the house user. Mirrors the per-code query above so
      // the aggregate strip's "Deposits" tile matches the sum of the
      // detail-page numbers.
      safe(
        db.$queryRawUnsafe<{
          volume: string;
          depositors: string;
          events: string;
        }[]>(
          `SELECT COALESCE(SUM((metadata->>'deposit_usd')::numeric), 0)::text AS volume,
                  COUNT(DISTINCT user_id)::text AS depositors,
                  COUNT(*)::text AS events
             FROM ledger_transactions
            WHERE type::text = 'deposit_bonus'
              AND UPPER(metadata->>'affiliate_code') = ANY($1::text[])`,
          upperCodeList,
        ),
        [] as { volume: string; depositors: string; events: string }[],
      ),
    ]);

  // Prefer ledger numbers for depositor count + volume — they cover
  // every booked deposit, not just the FTD slice. Fall back to the
  // affiliate_code_usages number if ledger query failed.
  const ledgerDepositors = Number(ledgerRow[0]?.depositors ?? 0);
  const ftdDepositors = Number(usageAggRow[0]?.depositors_ftd ?? 0);

  return {
    totalCodes,
    totalClicks: Number(clicksRow[0]?.count ?? 0),
    totalSignups: Number(usageAggRow[0]?.signups ?? 0),
    totalActiveReferrals: Number(activeRow[0]?.count ?? 0),
    totalDepositors: ledgerDepositors || ftdDepositors,
    totalDepositEventCount: Number(ledgerRow[0]?.events ?? 0),
    totalDepositVolumeUsd: toNumber(ledgerRow[0]?.volume ?? 0),
    totalFtdVolumeUsd: toNumber(usageAggRow[0]?.deposit ?? 0),
    totalWagerVolumeUsd: toNumber(usageAggRow[0]?.wager ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Per-code detail
// ---------------------------------------------------------------------------

export async function getAdCodeDetail(
  houseUserId: string,
  code: string,
): Promise<AdCodeDetail | null> {
  const db = await getDb();
  // Code lookup is case-insensitive — affiliate_codes has mixed casing
  // for legacy rows, but the URL slug always reaches us in some casing
  // and we shouldn't 404 just because of that mismatch.
  const recordRows = await safe(
    db.$queryRawUnsafe<{ code: string; created_at: Date }[]>(
      `SELECT code, created_at
         FROM affiliate_codes
        WHERE user_id = $1
          AND UPPER(code) = UPPER($2)
        LIMIT 1`,
      houseUserId,
      code,
    ),
    [] as { code: string; created_at: Date }[],
  );
  const record = recordRows[0];
  if (!record) return null;

  const upperCode = record.code.toUpperCase();
  const now = new Date();
  // Last 30 days inclusive of today.
  const thirtyDaysAgo = new Date(now.getTime() - 29 * MS_PER_DAY);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const [
    clicksCount,
    usageAggRow,
    activeReferralsRow,
    ledgerRow,
    clicksByDayRows,
    clicksByCountryRows,
    signupsRaw,
    usagesRaw,
  ] = await Promise.all([
    safe(
      db.$queryRawUnsafe<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count
           FROM affiliate_clicks
          WHERE UPPER(code) = $1`,
        upperCode,
      ),
      [] as { count: string }[],
    ),
    // Single batched aggregate against affiliate_code_usages. Replaces 3
    // separate aggregate round-trips (signups distinct, FTD deposit
    // distinct, deposit/wager sums) with one scan + FILTER clauses. Same
    // index, same filter, fewer plans.
    safe(
      db.$queryRawUnsafe<{
        signups: string;
        depositors_ftd: string;
        deposit: string;
        wager: string;
      }[]>(
        `SELECT
            COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type = 'signup')::text  AS signups,
            COUNT(DISTINCT referred_user_id) FILTER (WHERE usage_type = 'deposit')::text AS depositors_ftd,
            COALESCE(SUM(deposit_amount_usd::numeric), 0)::text                          AS deposit,
            COALESCE(SUM(wager_amount_usd::numeric),   0)::text                          AS wager
           FROM affiliate_code_usages
          WHERE affiliate_user_id = $1
            AND UPPER(code) = $2`,
        houseUserId,
        upperCode,
      ),
      [] as {
        signups: string;
        depositors_ftd: string;
        deposit: string;
        wager: string;
      }[],
    ),
    safe(
      db.$queryRawUnsafe<{ count: string }[]>(
        `SELECT COUNT(DISTINCT s.referred_user_id)::text AS count
           FROM affiliate_code_usages s
          WHERE s.affiliate_user_id = $1
            AND UPPER(s.code) = $2
            AND s.usage_type = 'signup'
            AND EXISTS (
              SELECT 1 FROM affiliate_code_usages a
              WHERE a.referred_user_id = s.referred_user_id
                AND UPPER(a.code) = $2
                AND a.usage_type IN ('deposit', 'wager')
            )`,
        houseUserId,
        upperCode,
      ),
      [] as { count: string }[],
    ),
    // Real deposit volume + counts from ledger.deposit_bonus events
    // pinned to this code via metadata.affiliate_code. Captures every
    // deposit booked here (not just FTD), so the headline tile reads
    // the code's real economic contribution.
    safe(
      db.$queryRawUnsafe<{
        volume: string;
        depositors: string;
        events: string;
      }[]>(
        `SELECT COALESCE(SUM((metadata->>'deposit_usd')::numeric), 0)::text AS volume,
                COUNT(DISTINCT user_id)::text AS depositors,
                COUNT(*)::text AS events
           FROM ledger_transactions
          WHERE type::text = 'deposit_bonus'
            AND UPPER(metadata->>'affiliate_code') = $1`,
        upperCode,
      ),
      [] as { volume: string; depositors: string; events: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ date: string; clicks: string }[]>(
        `SELECT TO_CHAR(DATE_TRUNC('day', created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
                COUNT(*)::text AS clicks
           FROM affiliate_clicks
          WHERE UPPER(code) = $1
            AND created_at >= $2
          GROUP BY DATE_TRUNC('day', created_at)
          ORDER BY DATE_TRUNC('day', created_at) ASC`,
        upperCode,
        thirtyDaysAgo,
      ),
      [] as { date: string; clicks: string }[],
    ),
    safe(
      db.$queryRawUnsafe<{ country: string; clicks: string }[]>(
        `SELECT country, COUNT(*)::text AS clicks
           FROM affiliate_clicks
          WHERE UPPER(code) = $1
          GROUP BY country
          ORDER BY COUNT(*) DESC
          LIMIT 10`,
        upperCode,
      ),
      [] as { country: string; clicks: string }[],
    ),
    // Signup list — pulled from affiliate_code_usages so we capture
    // every transactional signup event, not just users whose
    // referred_by/affiliate_code happens to still match. JOIN user for
    // username/email; use MIN(created_at) so a user with multiple
    // backfilled signup rows still shows up exactly once.
    safe(
      db.$queryRawUnsafe<
        {
          user_id: string;
          username: string | null;
          email: string | null;
          created_at: Date;
        }[]
      >(
        `SELECT acu.referred_user_id AS user_id,
                u.username,
                u.email,
                MIN(acu.created_at) AS created_at
           FROM affiliate_code_usages acu
           LEFT JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = $1
            AND UPPER(acu.code) = $2
            AND acu.usage_type = 'signup'
          GROUP BY acu.referred_user_id, u.username, u.email
          ORDER BY MIN(acu.created_at) DESC
          LIMIT 100`,
        houseUserId,
        upperCode,
      ),
      [] as {
        user_id: string;
        username: string | null;
        email: string | null;
        created_at: Date;
      }[],
    ),
    // Code Usage History — every user who has touched this code in
    // ANY usage_type (signup, deposit, wager...). Aggregates per-
    // (code, user) so a user with 5 deposit usages collapses to one
    // row with usage_count=5. SUM(wager_amount_usd) is the precise
    // answer to "which user contributed to this code's wager
    // volume?" — same field that feeds summary.wagerVolumeUsd.
    safe(
      db.$queryRawUnsafe<
        {
          user_id: string;
          username: string | null;
          email: string | null;
          usage_count: string;
          usage_types: string[] | null;
          attributed_wager: string;
          attributed_deposit: string;
          first_used_at: Date;
          last_used_at: Date;
        }[]
      >(
        `SELECT acu.referred_user_id                                                      AS user_id,
                u.username,
                u.email,
                COUNT(*)::text                                                             AS usage_count,
                ARRAY_AGG(DISTINCT acu.usage_type::text)                                   AS usage_types,
                COALESCE(SUM(acu.wager_amount_usd::numeric),   0)::text                    AS attributed_wager,
                COALESCE(SUM(acu.deposit_amount_usd::numeric), 0)::text                    AS attributed_deposit,
                MIN(acu.created_at)                                                        AS first_used_at,
                MAX(acu.created_at)                                                        AS last_used_at
           FROM affiliate_code_usages acu
           LEFT JOIN "user" u ON u.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = $1
            AND UPPER(acu.code) = $2
          GROUP BY acu.referred_user_id, u.username, u.email
          ORDER BY COALESCE(SUM(acu.wager_amount_usd::numeric), 0) DESC,
                   MAX(acu.created_at) DESC
          LIMIT 100`,
        houseUserId,
        upperCode,
      ),
      [] as {
        user_id: string;
        username: string | null;
        email: string | null;
        usage_count: string;
        usage_types: string[] | null;
        attributed_wager: string;
        attributed_deposit: string;
        first_used_at: Date;
        last_used_at: Date;
      }[],
    ),
  ]);

  // Combine user IDs from both lists so the lifetime-balances fetch
  // covers everyone we'll render (signups + usage-history rarely
  // overlap 100%; a user can wager via the code without showing up
  // as a signup, e.g. when the backend recorded only a deposit
  // usage row).
  const allUserIds = Array.from(
    new Set([
      ...signupsRaw.map((s) => s.user_id),
      ...usagesRaw.map((u) => u.user_id),
    ]),
  );
  const balances = allUserIds.length
    ? await safe(
        db.balances.findMany({
          where: { user_id: { in: allUserIds } },
          select: {
            user_id: true,
            total_deposited: true,
            total_wagered: true,
            total_won: true,
          },
        }),
        [] as {
          user_id: string;
          total_deposited: unknown;
          total_wagered: unknown;
          total_won: unknown;
        }[],
      )
    : [];
  const balanceMap = new Map(
    balances.map((b) => [
      b.user_id,
      {
        deposited: toNumber(b.total_deposited),
        wagered: toNumber(b.total_wagered),
        won: toNumber(b.total_won),
      },
    ]),
  );

  // Build a contiguous 30-day series so the chart doesn't render gaps
  // on zero-click days.
  const dayMap = new Map(clicksByDayRows.map((r) => [r.date, Number(r.clicks)]));
  const clicksByDay: AdCodeClicksByDay[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo.getTime() + i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    clicksByDay.push({ date: key, clicks: dayMap.get(key) ?? 0 });
  }

  const clicksCountNum = Number(clicksCount[0]?.count ?? 0);
  const signupsCountNum = Number(usageAggRow[0]?.signups ?? 0);
  const ledgerVolume = toNumber(ledgerRow[0]?.volume ?? 0);
  const ledgerDepositors = Number(ledgerRow[0]?.depositors ?? 0);
  const ledgerEvents = Number(ledgerRow[0]?.events ?? 0);
  const ftdDepositors = Number(usageAggRow[0]?.depositors_ftd ?? 0);
  const summary: AdCodeSummary = {
    code: record.code,
    createdAt: record.created_at.toISOString(),
    clicks: clicksCountNum,
    signups: signupsCountNum,
    activeReferrals: Number(activeReferralsRow[0]?.count ?? 0),
    // Ledger preferred — captures every deposit, not just FTD. Falls
    // back to the FTD-only count if the ledger query came back empty
    // (empty schema / safe() catch).
    depositors: ledgerDepositors || ftdDepositors,
    depositEventCount: ledgerEvents,
    depositVolumeUsd: ledgerVolume,
    ftdVolumeUsd: toNumber(usageAggRow[0]?.deposit ?? 0),
    wagerVolumeUsd: toNumber(usageAggRow[0]?.wager ?? 0),
    conversionRate: clicksCountNum > 0 ? signupsCountNum / clicksCountNum : 0,
  };

  return {
    code: record.code,
    createdAt: record.created_at.toISOString(),
    summary,
    clicksByDay,
    clicksByCountry: clicksByCountryRows.map((r) => ({
      country: r.country,
      clicks: Number(r.clicks),
    })),
    // Re-sort the signups by activity (wager DESC, then deposit DESC,
    // then signup date DESC) so the users actually moving the code's
    // wager/deposit numbers surface at the top. The raw query orders
    // by signup time which buries active users behind tire-kickers.
    signupsList: signupsRaw
      .map((s) => {
        const b =
          balanceMap.get(s.user_id) ?? { deposited: 0, wagered: 0, won: 0 };
        return {
          userId: s.user_id,
          username: s.username,
          email: s.email,
          createdAt: s.created_at.toISOString(),
          totalDepositedUsd: b.deposited,
          totalWageredUsd: b.wagered,
          isFtd: b.deposited > 0,
        };
      })
      .sort((a, b) => {
        if (b.totalWageredUsd !== a.totalWageredUsd)
          return b.totalWageredUsd - a.totalWageredUsd;
        if (b.totalDepositedUsd !== a.totalDepositedUsd)
          return b.totalDepositedUsd - a.totalDepositedUsd;
        return b.createdAt.localeCompare(a.createdAt);
      }),
    // Usage history — every user who's ever touched the code, with
    // attribution (acu sums) AND lifetime context (balances). Already
    // sorted by SUM(wager_amount_usd) DESC in SQL.
    usageHistory: usagesRaw.map((u) => {
      const b =
        balanceMap.get(u.user_id) ?? { deposited: 0, wagered: 0, won: 0 };
      return {
        userId: u.user_id,
        username: u.username,
        email: u.email,
        usageCount: Number(u.usage_count),
        usageTypes: u.usage_types ?? [],
        attributedWagerUsd: Number(u.attributed_wager),
        attributedDepositUsd: Number(u.attributed_deposit),
        lifetimeWageredUsd: b.wagered,
        lifetimeWonUsd: b.won,
        lifetimeDepositedUsd: b.deposited,
        firstUsedAt: u.first_used_at.toISOString(),
        lastUsedAt: u.last_used_at.toISOString(),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// House user lookup — resolves the configured house user id to a
// display-friendly payload for the header.
// ---------------------------------------------------------------------------

export async function getHouseUserInfo(
  houseUserId: string,
): Promise<{ id: string; username: string | null; email: string | null } | null> {
  const db = await getDb();
  const user = await safe(
    db.user.findUnique({
      where: { id: houseUserId },
      select: { id: true, username: true, email: true },
    }),
    null,
  );
  return user ?? null;
}
