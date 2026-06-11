import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { withTimeout, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { blacklistNotInClause } from "./_blacklist";
import type { PaginatedResult } from "@/lib/types";
import type { CreatorTipItem } from "./creators-types";

// Lifetime-lookback cap (days) for the "all-time" branches of the creator
// detail aggregate. Several legs here had NO lower bound and scanned the
// FULL history of their source table on every render — the unbounded-
// lifetime pattern CLAUDE.md's "Performance & Daten-Laden" section forbids:
//   • signupCounts.total      — full scan of "user" by referred_by
//   • realAffiliateAgg        — full scan of affiliate_code_usages (the
//                               wager/commission/FTD/active rollup)
//   • ftdStats `'all'`        — the CROSS JOIN's unbounded period branch
//                               over affiliate_code_usages × balances
//   • clickCounts.total       — full scan of affiliate_clicks by code
//   • countryBreakdown        — full scan of affiliate_clicks + "user"
//
// 365 days mirrors the SAME lifetime guard the rest of the codebase uses for
// lifetime scans (`GGR_LIFETIME_LOOKBACK_DAYS`, the insights-rewards
// `INSIGHTS_LIFETIME_LOOKBACK_DAYS`, the creator-PnL `LIFETIME_LOOKBACK_DAYS`
// one folder over — all 365). The affiliate / creator program is recent
// enough that a rolling 365-day window covers effectively all real
// attributed activity, so the displayed "total" figures are unchanged in
// practice; the bound only removes the full-history seq-scan. Inlined as a
// local constant (rather than imported across the unrelated /ggr surface) to
// keep this module decoupled, matching how those modules each inline 365.
const CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS = 365;
const CREATOR_DETAIL_LIFETIME_INTERVAL = `INTERVAL '${CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS} days'`;

/**
 * Slim header-only query for the creator sub-pages. Returns just the
 * fields the PageHero needs (username/email/image/role/code) without
 * pulling in the whole detail page's 12-round-trip aggregate.
 *
 * Used by /creators/[userId]/users and /creators/[userId]/wagers, which
 * only render the avatar + name + primary code in their PageHero. The
 * full getCreatorDetail() pulls click counts, signup buckets, FTD
 * stats, country breakdowns, etc. — none of which the sub-pages use.
 */
export async function getCreatorHeader(userId: string) {
  const db = await getDb();
  const [primaryCodeRow, user] = await Promise.all([
    db.$queryRawUnsafe<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      userId,
    ),
    db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        email: true,
        image: true,
        role: true,
      },
    }),
  ]);

  if (!user) return null;

  return {
    userId,
    username: user.username,
    email: user.email,
    image: user.image,
    role: user.role,
    code: primaryCodeRow[0]?.code ?? "",
  };
}

/**
 * Server-side query that powers /creators/[userId]. Returns ONLY the fields
 * the page actually renders — every property in the return shape maps to a
 * concrete consumer in `page.tsx` or one of its children.
 *
 * Previous incarnations of this function fetched payouts, webhooks, deals,
 * limits, the full referrals page (with N usages + balances), pnl by ledger
 * scan, and webhook deliveries. None of those were rendered after the page
 * was refactored to stream LeaderboardsCard + CodeActivityCard via Suspense
 * and to source deal data from the backend admin API. Removing them brings
 * this query from ~21 round-trips down to 12.
 */
export async function getCreatorDetail(userId: string) {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  // Fetch the affiliate account and the user record in parallel. A user can
  // exist without ever being promoted to an affiliate (no affiliate_accounts
  // row, no affiliate_codes). The detail page should still render for these
  // users with an "no affiliate code yet" banner instead of a hard 404 — only
  // truly unknown user IDs should 404.
  const [account, userBasic] = await Promise.all([
    db.affiliate_accounts.findUnique({
      where: { user_id: userId },
      select: {
        // Only the columns the page renders. The *_usd fields back the
        // FinancialsCard + the KPI strip. last_payout_at, created_at,
        // total_wager_volume_usd, total_earned_usd, total_referred are
        // intentionally dropped — none of them flow to the rendered UI
        // (the wager/earned/referred KPI tiles read from the staff-
        // excluded realAffiliateAgg below instead).
        available_usd: true,
        total_paid_out_usd: true,
        total_bonus_distributed_usd: true,
        user: {
          select: {
            username: true,
            email: true,
            image: true,
            role: true,
          },
        },
      },
    }),
    db.user.findUnique({
      where: { id: userId },
      // Only the columns the page renders. id is unused (we already have
      // userId from the route param), created_at not displayed.
      select: {
        username: true,
        email: true,
        image: true,
        role: true,
      },
    }),
  ]);

  if (!account && !userBasic) return null;

  const hasAffiliateAccount = !!account;
  const userInfo = account?.user ?? userBasic ?? null;

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  // Lower bound for the "total" / all-time buckets — see
  // CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS. The finite 24h/7d/14d/30d buckets
  // already self-bound; this only caps the otherwise-unbounded total scans so
  // a creator with a long history doesn't trigger a full-table seq-scan.
  const lifetimeCutoff = new Date(
    now.getTime() - CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  // First wave — every query that only depends on userId. signupCounts +
  // ftdStats use raw SQL so each batches multiple period buckets into a
  // single round-trip. socials trims to the columns HeaderSocials renders
  // (the table also stores access tokens, JSON stat blobs, etc. that we
  // don't need on this page). realAffiliateAgg re-derives the wager
  // volume + commission with staff (admin/support) excluded — the stored
  // affiliate_accounts.total_* counters include staff and previously
  // inflated the KPI tile.
  //
  // NOTE: `user.affiliate_code` is NOT this creator's own code — it's the
  // referral cookie they are carrying from another creator who referred
  // THEM. The only source of truth for a creator's own codes is the
  // `affiliate_codes` table, populated exclusively by
  // affiliate.service.ts#createCode.
  // Timeout-bound the heavy fan-out: the realAffiliateAgg / ftdStats raw
  // aggregates are the dominant cost here, and on a prod DB lacking the
  // supporting acu indexes a single slow leg would otherwise pin a MAIN
  // `max:5` pool slot until the platform tears the request down. Racing the
  // wave against REWARD_QUERY_TIMEOUT_MS lets it reject with a QueryTimeoutError
  // instead — which the page's outer `safeQueryOrNull` wrapper catches and
  // degrades to the per-band fallback (the underlying statement keeps running
  // on its own connection and warms the cache for the next load). The DB shape
  // is unchanged — this only bounds how long WE wait.
  const [
    allCodes,
    socials,
    signupCounts,
    realAffiliateAgg,
    ftdStats,
  ] = await withTimeout(
    () =>
      Promise.all([
    // Only `code` is needed — primaryCode = first row, clickCodes = the
    // upper-cased set of all codes. created_at participates only in the
    // ORDER BY (no need to SELECT it).
    db.$queryRawUnsafe<{ code: string }[]>(
      `SELECT code FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at ASC`,
      userId,
    ),
    // Only the fields HeaderSocials renders + last_fetched_at, which is
    // declared `lastFetchedAt: string | null` (required) on the consumer's
    // SocialLike type. Skipping access_token, refresh_token, stats_json
    // (potentially large JSON), and the various avg_views/engagement
    // columns the chip never displays.
    adminDb.creator_socials.findMany({
      where: { target_user_id: userId },
      orderBy: { platform: "asc" },
      select: {
        id: true,
        platform: true,
        username: true,
        follower_count: true,
        subscriber_count: true,
        last_fetched_at: true,
      },
    }),
    // Single batched query replaces 4 separate user.count() round-trips
    // (total + 24h + 7d + 30d). Same index scan, fewer plans + a single
    // network round-trip. Preserves the exact return semantics of the
    // four count() calls.
    db.$queryRaw<
      {
        total: string;
        last_24h: string;
        last_7d: string;
        last_14d: string;
        last_30d: string;
      }[]
    >`
      SELECT
        COUNT(*)::text                                                                AS total,
        COUNT(*) FILTER (WHERE created_at >= ${oneDayAgo})::text                      AS last_24h,
        COUNT(*) FILTER (WHERE created_at >= ${sevenDaysAgo})::text                   AS last_7d,
        COUNT(*) FILTER (WHERE created_at >= ${fourteenDaysAgo})::text                AS last_14d,
        COUNT(*) FILTER (WHERE created_at >= ${thirtyDaysAgo})::text                  AS last_30d
      FROM "user"
      WHERE referred_by = ${userId}
        -- Lifetime cap: bound the otherwise-unbounded total signup scan to
        -- a 365-day lookback (CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS).
        AND created_at >= ${lifetimeCutoff}
    `,
    // Real wager + commission aggregate, excluding staff (admin +
    // support) so the KPI tiles + financials card don't double-count
    // internal accounts. The stored affiliate_accounts.total_*
    // fields are kept up-to-date by the backend but include EVERY
    // referral including staff, which is why void was inflating the
    // wager-volume tile.
    //
    // Also computes the two header KPIs that sit next to Signups:
    //   • ftd_count — distinct referred users who actually deposited
    //     (gates on both `usage_type='deposit'` for THIS creator AND
    //     a balances row with `total_deposited > 0`, matching the
    //     existing ftdByPeriod query exactly so the FunnelTable + KPI
    //     tile agree). Uses an EXISTS subquery to avoid joining
    //     balances directly — that join would multiply rows per user
    //     and inflate the SUM aggregates above.
    //   • active_7d — distinct referrals with any deposit/wager
    //     activity in the last 7 days. Drives the "Active affi"
    //     tile so the admin can see who's still engaged inside the
    //     attribution window.
    db.$queryRawUnsafe<
      {
        wager_volume: string;
        commission: string;
        ftd_count: string;
        active_7d: string;
        active_24h: string;
        pack_wager: string;
        battle_wager: string;
        upgrader_wager: string;
      }[]
    >(
      `SELECT
         COALESCE(SUM(acu.wager_amount_usd::numeric),   0)::text AS wager_volume,
         COALESCE(SUM(acu.referrer_cut_usd::numeric),   0)::text AS commission,
         COUNT(DISTINCT acu.referred_user_id) FILTER (
           WHERE acu.usage_type::text = 'deposit'
             AND EXISTS (
               SELECT 1 FROM balances b
               WHERE b.user_id = acu.referred_user_id
                 AND b.total_deposited > 0
             )
         )::text AS ftd_count,
         COUNT(DISTINCT acu.referred_user_id) FILTER (
           WHERE acu.usage_type::text IN ('deposit', 'wager')
             AND acu.created_at >= NOW() - INTERVAL '7 days'
         )::text AS active_7d,
         COUNT(DISTINCT acu.referred_user_id) FILTER (
           WHERE acu.usage_type::text IN ('deposit', 'wager')
             AND acu.created_at >= NOW() - INTERVAL '1 day'
         )::text AS active_24h,
         -- Per-game-type slice of the wager_volume above. Sourced via
         -- a LEFT JOIN onto game_sessions on the wager rows
         -- (game_session_id) so deposit rows (NULL game_session_id)
         -- drop out naturally — they only contribute to wager_volume
         -- via the same wager_amount_usd column being 0. The three
         -- SUM-CASE values therefore add up to wager_volume exactly,
         -- which lets the UI render them as a verifiable breakdown
         -- under the Wager Volume number.
         -- game_type/usage_type compared via ::text (NOT the bare enum):
         -- the generated Prisma enum is AHEAD of live prod (e.g. prod
         -- game_type = {pack, battle} with NO 'upgrader' label), and a bare
         -- comparison against a label the DB doesn't know throws 22P02 at
         -- PARSE time — killing this whole statement (the ffa61b5c failure
         -- class). ::text compares false instead, so a missing label just
         -- contributes $0.
         COALESCE(SUM(CASE WHEN gs.game_type::text = 'pack'     THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS pack_wager,
         COALESCE(SUM(CASE WHEN gs.game_type::text = 'battle'   THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS battle_wager,
         COALESCE(SUM(CASE WHEN gs.game_type::text = 'upgrader' THEN acu.wager_amount_usd::numeric ELSE 0 END), 0)::text AS upgrader_wager
       FROM affiliate_code_usages acu
       JOIN "user" u ON u.id = acu.referred_user_id
       LEFT JOIN game_sessions gs ON gs.id = acu.game_session_id
       WHERE acu.affiliate_user_id = $1
         AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
         -- Lifetime cap: bound this otherwise-unbounded rollup (wager /
         -- commission / FTD / active) to a 365-day lookback so it never
         -- seq-scans the full affiliate_code_usages history. The 24h / 7d
         -- active FILTERs above are already tighter than this bound.
         AND acu.created_at >= NOW() - ${CREATOR_DETAIL_LIFETIME_INTERVAL}`,
      userId,
    ),
    // FTD-by-period — distinct depositors referred by this creator
    // bucketed into the periods the FunnelTable renders. Independent of
    // the (now removed) referrals listing, so it lives here in the first
    // wave alongside everything else userId-only.
    db.$queryRawUnsafe<{ period: string; count: string }[]>(
      `
      SELECT period, COUNT(*)::text AS count FROM (
        SELECT DISTINCT acu.referred_user_id, p.period
        FROM affiliate_code_usages acu
        JOIN balances b ON b.user_id = acu.referred_user_id AND b.total_deposited > 0
        CROSS JOIN (VALUES ('1d'), ('3d'), ('7d'), ('14d'), ('30d'), ('all')) AS p(period)
        WHERE acu.affiliate_user_id = $1
          AND acu.usage_type::text = 'deposit'
          -- Lifetime cap: the 'all' branch was unbounded (full
          -- affiliate_code_usages × balances scan). Bound it to a 365-day
          -- lookback (CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS) so the CROSS
          -- JOIN never seq-scans the whole history; the finite buckets keep
          -- their own tighter windows.
          AND acu.created_at >= NOW() - ${CREATOR_DETAIL_LIFETIME_INTERVAL}
          AND (
            p.period = 'all'
            OR acu.created_at >= NOW() - CASE p.period
              WHEN '1d' THEN INTERVAL '1 day'
              WHEN '3d' THEN INTERVAL '3 days'
              WHEN '7d' THEN INTERVAL '7 days'
              WHEN '14d' THEN INTERVAL '14 days'
              WHEN '30d' THEN INTERVAL '30 days'
            END
          )
      ) sub
      GROUP BY period
    `,
      userId,
    ),
      ]),
    REWARD_QUERY_TIMEOUT_MS,
  );

  const signupsRow = signupCounts[0];
  const signupsTotal = Number(signupsRow?.total ?? 0);
  const signups24h = Number(signupsRow?.last_24h ?? 0);
  const signups7d = Number(signupsRow?.last_7d ?? 0);
  const signups14d = Number(signupsRow?.last_14d ?? 0);
  const signups30d = Number(signupsRow?.last_30d ?? 0);
  // Primary = oldest row in affiliate_codes (the first code this creator
  // ever minted). `allCodes` is already ORDER BY created_at ASC above.
  const primaryCode = allCodes[0]?.code ?? "";

  // Backend always inserts affiliate_clicks with code.toUpperCase() (see
  // affiliate.service.ts#trackClick), and creators can own multiple codes —
  // click totals must cover every code they own so additional codes aren't
  // silently undercounted.
  const clickCodes = Array.from(
    new Set(allCodes.map((c) => c.code.toUpperCase()).filter((c) => !!c)),
  );

  const now_clicks_24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const now_clicks_7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const now_clicks_14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const now_clicks_30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Gate the click/country aggregates on the creator actually owning codes —
  // a creator with no codes runs a noop instead of scanning affiliate_clicks
  // for an empty IN-list.
  const hasClickCodes = clickCodes.length > 0;

  // Second heavy wave — clicks + country FULL OUTER JOIN. Same timeout
  // protection as the first wave so a slow affiliate_clicks scan degrades
  // (via the page's outer safeQueryOrNull) instead of pinning a pool slot.
  const [clickCounts, pendingSignups, countryBreakdown] = await withTimeout(
    () =>
      Promise.all([
    // Single batched aggregate replaces 4 separate affiliate_clicks.count()
    // round-trips (total + 24h + 7d + 30d). One index scan with FILTER
    // clauses, no extra plans.
    hasClickCodes
      ? db.$queryRaw<
          {
            total: string;
            last_24h: string;
            last_7d: string;
            last_14d: string;
            last_30d: string;
          }[]
        >`
          SELECT
            COUNT(*)::text                                                              AS total,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_24h})::text               AS last_24h,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_7d})::text                AS last_7d,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_14d})::text               AS last_14d,
            COUNT(*) FILTER (WHERE created_at >= ${now_clicks_30d})::text               AS last_30d
          FROM affiliate_clicks
          WHERE code = ANY(${clickCodes}::text[])
            -- Lifetime cap: bound the otherwise-unbounded total click scan to
            -- a 365-day lookback (CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS).
            AND created_at >= ${lifetimeCutoff}
        `
      : Promise.resolve(
          [] as { total: string; last_24h: string; last_7d: string; last_14d: string; last_30d: string }[],
        ),
    primaryCode
      ? db.affiliate_code_queue.count({ where: { code: primaryCode } })
      : Promise.resolve(0),
    // Country-level breakdown. Clicks are stored with the FULL country
    // name (affiliate_clicks.country, populated by the geolocation service
    // at track time). Signed-up users also carry a `country` column from
    // the same service at signup. Joining on the full name is therefore
    // safe — they flow from the same source. FULL OUTER JOIN so countries
    // with only clicks OR only signups both show up.
    db.$queryRawUnsafe<{ country: string; clicks: number; signups: number }[]>(
      `
      WITH click_countries AS (
        SELECT country, COUNT(*)::int AS clicks
        FROM affiliate_clicks
        WHERE code = ANY($1::text[])
          AND country IS NOT NULL AND country <> 'unknown'
          -- Lifetime cap: bound the otherwise-unbounded click scan to a
          -- 365-day lookback (CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS).
          AND created_at >= NOW() - ${CREATOR_DETAIL_LIFETIME_INTERVAL}
        GROUP BY country
      ),
      signup_countries AS (
        SELECT country, COUNT(*)::int AS signups
        FROM "user"
        WHERE referred_by = $2
          AND country IS NOT NULL AND country <> ''
          -- Lifetime cap: same 365-day bound on the referred-signup scan so
          -- the FULL OUTER JOIN never seq-scans the whole "user" history.
          AND created_at >= NOW() - ${CREATOR_DETAIL_LIFETIME_INTERVAL}
        GROUP BY country
      )
      SELECT
        COALESCE(c.country, s.country) AS country,
        COALESCE(c.clicks, 0) AS clicks,
        COALESCE(s.signups, 0) AS signups
      FROM click_countries c
      FULL OUTER JOIN signup_countries s ON c.country = s.country
      WHERE COALESCE(c.country, s.country) IS NOT NULL
      ORDER BY (COALESCE(c.clicks, 0) + COALESCE(s.signups, 0)) DESC
      LIMIT 30
      `,
      hasClickCodes ? clickCodes : ["__none__"],
      userId,
    ),
      ]),
    REWARD_QUERY_TIMEOUT_MS,
  );

  // Unpack the consolidated click counts (5 buckets in 1 row).
  const clicksRow = clickCounts[0];
  const clickCount = Number(clicksRow?.total ?? 0);
  const clicks24h = Number(clicksRow?.last_24h ?? 0);
  const clicks7d = Number(clicksRow?.last_7d ?? 0);
  const clicks14d = Number(clicksRow?.last_14d ?? 0);
  const clicks30d = Number(clicksRow?.last_30d ?? 0);

  const ftdByPeriod: Record<string, number> = {
    "1d": 0,
    "3d": 0,
    "7d": 0,
    "14d": 0,
    "30d": 0,
    all: 0,
  };
  for (const row of ftdStats) {
    ftdByPeriod[row.period] = Number(row.count);
  }

  return {
    userId,
    hasAffiliateAccount,
    username: userInfo?.username ?? null,
    email: userInfo?.email ?? null,
    image: userInfo?.image ?? null,
    role: userInfo?.role ?? "user",
    code: primaryCode,
    // Wager volume + commission earned override the stored
    // affiliate_accounts.total_* counters with live aggregates that
    // exclude staff (admin + support). The stored fields keep a
    // running total of every usage including staff/internal accounts,
    // which mis-states what real customer activity looks like.
    totalWagerVolumeUsd: toNumber(realAffiliateAgg[0]?.wager_volume ?? "0"),
    // Per-game-type breakdown of `totalWagerVolumeUsd` — sums to it
    // exactly. The FinancialsCard renders these as indented sub-rows
    // beneath "Wager Volume" so the operator can see where the
    // creator's referred users actually played.
    wagerBreakdown: {
      packs: toNumber(realAffiliateAgg[0]?.pack_wager ?? "0"),
      battles: toNumber(realAffiliateAgg[0]?.battle_wager ?? "0"),
      upgrader: toNumber(realAffiliateAgg[0]?.upgrader_wager ?? "0"),
    },
    totalEarnedUsd: toNumber(realAffiliateAgg[0]?.commission ?? "0"),
    // FTDs (all-time, this creator's code) + active referrals in
    // multiple windows — fed into KPI tiles next to Signups. All
    // staff-excluded by the same JOIN as the wager/commission
    // aggregates. activeReferrals24h surfaces on the "Active affi"
    // tile's subtitle so the admin can see momentum at a glance.
    ftdCount: Number(realAffiliateAgg[0]?.ftd_count ?? 0),
    activeReferrals7d: Number(realAffiliateAgg[0]?.active_7d ?? 0),
    activeReferrals24h: Number(realAffiliateAgg[0]?.active_24h ?? 0),
    availableUsd: toNumber(account?.available_usd ?? 0),
    totalPaidOutUsd: toNumber(account?.total_paid_out_usd ?? 0),
    totalBonusDistributedUsd: toNumber(account?.total_bonus_distributed_usd ?? 0),
    clicks: {
      total: clickCount,
      last24h: clicks24h,
      last7d: clicks7d,
      last14d: clicks14d,
      last30d: clicks30d,
    },
    countryBreakdown: countryBreakdown.map((r) => ({
      country: r.country,
      clicks: Number(r.clicks),
      signups: Number(r.signups),
    })),
    signups: {
      total: signupsTotal,
      last24h: signups24h,
      last7d: signups7d,
      last14d: signups14d,
      last30d: signups30d,
      pending: pendingSignups,
    },
    ftdByPeriod,
    socials: socials.map((s) => ({
      id: s.id,
      platform: s.platform,
      username: s.username,
      followerCount: s.follower_count,
      subscriberCount: s.subscriber_count,
      lastFetchedAt: s.last_fetched_at?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Cross-request cache for getCreatorDetail
// ---------------------------------------------------------------------------
//
// `getCreatorDetail` is the heaviest read on /creators/[userId] — a ~12
// Main-DB round-trip aggregate (click/signup/country buckets + the
// affiliate wager/commission rollup + FTD-by-period). It is fired ONCE per
// render but shared across two page positions (KPI strip + acquisition/
// payouts band) via a single in-flight promise. Without a cache layer every
// render — including each press of the page's "Refresh to retry" banner
// after a different heavy panel timed out — re-pays the full aggregate, and
// on a prod DB lacking the supporting acu indexes that is exactly what blows
// past the page's safeQuery budget and degrades the bands.
//
// `unstable_cache` keyed on the creator id means the aggregate runs at most
// once per TTL; repeat loads / retries resolve from the warmed entry. The
// numbers are UNCHANGED — this only memoizes the existing query result. Same
// precedent as `users-detail-cache.ts` and the sibling creator caches
// (`_pnl-cache.ts`, `_cost-cache.ts`).
//
// ENV NOTE (prod-pinned, matches the repo pattern): `getCreatorDetail` calls
// `getDb()` internally, which resolves the per-admin `admin_db_env` cookie.
// `unstable_cache` runs its callback OUTSIDE the request's dynamic scope, so
// a `cookies()` read inside it throws and `readDbEnv` falls back to "prod".
// We therefore cache ONLY when the request is on prod (the default, and the
// path the production timeout bug is about); a dev-toggled admin bypasses the
// cache and runs the query directly so they always see live dev data.
// Identical to `users-detail-cache.ts` / `_pnl-cache.ts`.

// 60s — the aggregate is mostly funnel/acquisition counters that move
// continuously, so a short TTL keeps a newly-recorded click/signup/deposit
// surfacing promptly while still collapsing the refresh/retry storm. (The
// heavier 365-day PnL scan one module over uses 300s because it barely moves
// minute-to-minute; this aggregate is lighter and more time-sensitive.)
const CREATOR_DETAIL_REVALIDATE_SECONDS = 60;

const cachedCreatorDetail = unstable_cache(
  (userId: string): Promise<Awaited<ReturnType<typeof getCreatorDetail>>> =>
    getCreatorDetail(userId),
  ["creators-detail-aggregate-v1"],
  { revalidate: CREATOR_DETAIL_REVALIDATE_SECONDS, tags: ["creators-detail"] },
);

/** Cached `getCreatorDetail` on prod; direct (uncached) on a dev-toggled
 * admin so they see live dev data — see section doc above. */
export async function getCreatorDetailCached(
  userId: string,
): Promise<Awaited<ReturnType<typeof getCreatorDetail>>> {
  const env = await readDbEnv();
  if (env !== "prod") return getCreatorDetail(userId);
  return cachedCreatorDetail(userId);
}

// ---------------------------------------------------------------------------
// Creator Tips — rain tips sent by this creator
// ---------------------------------------------------------------------------

export async function getCreatorTips(
  userId: string,
  page: number = 1,
  perPage: number = 20,
): Promise<PaginatedResult<CreatorTipItem> & { totalTipped: number }> {
  const db = await getDb();
  const [tips, total, totalAgg] = await Promise.all([
    db.rain_tips.findMany({
      where: { user_id: userId },
      include: {
        rains: {
          select: {
            id: true,
            total_pool_usd: true,
            status: true,
            winner_user_id: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.rain_tips.count({ where: { user_id: userId } }),
    db.rain_tips.aggregate({
      where: { user_id: userId },
      _sum: { amount_usd: true },
    }),
  ]);

  // Batch-fetch winner usernames
  const winnerIds = [
    ...new Set(
      tips
        .map((t) => t.rains.winner_user_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const winners =
    winnerIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: winnerIds } },
          select: { id: true, username: true, email: true },
        })
      : [];
  const winnerMap = new Map(
    winners.map((w) => [w.id, w.username ?? w.email ?? w.id.slice(0, 8)]),
  );

  return {
    data: tips.map((t) => ({
      id: t.id,
      rainId: t.rain_id,
      amountUsd: toNumber(t.amount_usd),
      rainTotalPool: toNumber(t.rains.total_pool_usd),
      rainStatus: t.rains.status,
      rainWinnerUsername: t.rains.winner_user_id
        ? winnerMap.get(t.rains.winner_user_id) ?? null
        : null,
      createdAt: t.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
    totalTipped: toNumber(totalAgg._sum.amount_usd ?? 0),
  };
}
