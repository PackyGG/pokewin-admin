import { cache } from "react";
import { getDb } from "@/lib/db";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/utils/time";
import {
  excludeStaffAndBlacklisted,
  blacklistNotInClause,
} from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getRealizedPnlSnapshot } from "./_realized-pnl";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "./_wager-payout-types";

/**
 * Single raw query that returns revenue (deposits), withdrawal, wager and GGR
 * totals bucketed by period in ONE round-trip. Previously this was 20
 * separate aggregate calls (4 metrics × 5 periods) — each requires its own
 * plan + execution, and the underlying index scan is the same. Collapsing
 * into one query shaves ~15 round-trips off the hot dashboard path.
 *
 * All cutoffs are TRUE ROLLING WINDOWS from `now` (1h ago, 3h ago, …,
 * 24h ago, 3d ago …). The 24h bucket used to be `startOfDay` (UTC
 * midnight = calendar day) which made the card reset to zero every
 * midnight and read like a partial half-day for most of the morning
 * — out of step with the other rolling chips on the same card. The
 * fix unifies the semantic: every chip is now `now − N`.
 *
 * Row shape: one text column per (metric × period). Caller converts to
 * number via toNumber / parseFloat.
 *
 * Note on withdrawals: revenue/wager/GGR come from `ledger_transactions`,
 * but withdrawals come from `card_withdrawal_requests` (status IN
 * completed/shipped) so the StatCard matches the PnL formula's source of
 * truth. Some pre-Fireblocks completions never got their ledger entry's
 * status flipped to 'completed' — those withdrawals are real (money left
 * the house) but a ledger-based query misses them. The request table is
 * the authoritative record.
 */
function getPeriodAggregates(
  db: PrismaClient,
  oneHourAgo: Date,
  threeHoursAgo: Date,
  sixHoursAgo: Date,
  twelveHoursAgo: Date,
  // Rolling 24h cutoff — `now − 24h`. NOT the start of the UTC day.
  // Renamed from the old `startOfDay` to make the new semantic
  // obvious at every call site.
  twentyFourHoursAgo: Date,
  threeDaysAgo: Date,
  sevenDaysAgo: Date,
  thirtyDaysAgo: Date,
  blacklistIdNotIn: string,
  // A `session_windows(uid, win_start, win_end)` CTE definition (built
  // by getCreatorSessionWindowsCte) — every creator deal/stream session.
  // Wagers a creator made inside one of these windows are dropped from
  // the customer wager figure.
  sessionWindowsCte: string,
) {
  // GGR wager/payout type sets — built ONCE from the canonical shared
  // constants (src/lib/queries/_wager-payout-types.ts) and interpolated
  // into every GGR period block below via Prisma.raw, instead of being
  // re-typed inline 9× (where the 19-item payout list inevitably drifts).
  // The values are hardcoded ledger-type strings — no external input —
  // so Prisma.raw is injection-safe here.
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
  return db.$queryRaw<
    {
      revenue_1h: string; revenue_3h: string; revenue_6h: string; revenue_12h: string;
      revenue_24h: string; revenue_3d: string; revenue_7d: string; revenue_30d: string; revenue_all: string;
      withdrawal_1h: string; withdrawal_3h: string; withdrawal_6h: string; withdrawal_12h: string;
      withdrawal_24h: string; withdrawal_3d: string; withdrawal_7d: string; withdrawal_30d: string; withdrawal_all: string;
      wager_1h: string; wager_3h: string; wager_6h: string; wager_12h: string;
      wager_24h: string; wager_3d: string; wager_7d: string; wager_30d: string; wager_all: string;
      // Customer wager — wager_* MINUS wagers a creator made while live
      // on a deal/stream (house-funded "sponsored" play).
      wager_excl_session_1h: string; wager_excl_session_3h: string; wager_excl_session_6h: string; wager_excl_session_12h: string;
      wager_excl_session_24h: string; wager_excl_session_3d: string; wager_excl_session_7d: string; wager_excl_session_30d: string; wager_excl_session_all: string;
      // Customer wager broken down by source (Packs vs Battles) for the
      // "Where the wager comes from" chip row under the Total Wager
      // card. Same exclusion as wager_excl_session_* — creators' on-
      // stream sponsored wagers are dropped. The two columns sum to
      // wager_excl_session_* per window.
      pack_wager_excl_session_1h: string; pack_wager_excl_session_3h: string; pack_wager_excl_session_6h: string; pack_wager_excl_session_12h: string;
      pack_wager_excl_session_24h: string; pack_wager_excl_session_3d: string; pack_wager_excl_session_7d: string; pack_wager_excl_session_30d: string; pack_wager_excl_session_all: string;
      battle_wager_excl_session_1h: string; battle_wager_excl_session_3h: string; battle_wager_excl_session_6h: string; battle_wager_excl_session_12h: string;
      battle_wager_excl_session_24h: string; battle_wager_excl_session_3d: string; battle_wager_excl_session_7d: string; battle_wager_excl_session_30d: string; battle_wager_excl_session_all: string;
      upgrader_wager_excl_session_1h: string; upgrader_wager_excl_session_3h: string; upgrader_wager_excl_session_6h: string; upgrader_wager_excl_session_12h: string;
      upgrader_wager_excl_session_24h: string; upgrader_wager_excl_session_3d: string; upgrader_wager_excl_session_7d: string; upgrader_wager_excl_session_30d: string; upgrader_wager_excl_session_all: string;
      // Wager from users who did NOT join under an official creator
      // code — referred_by is null OR referred_by points to a non-
      // creator-role user. Same exclusion as wager_excl_session_* on
      // top (creator-on-stream play already dropped) so this surfaces
      // pure organic customer wager: not attributed to creator
      // marketing, not house-funded promo.
      wager_organic_1h: string; wager_organic_3h: string; wager_organic_6h: string; wager_organic_12h: string;
      wager_organic_24h: string; wager_organic_3d: string; wager_organic_7d: string; wager_organic_30d: string; wager_organic_all: string;
      ggr_1h: string; ggr_3h: string; ggr_6h: string; ggr_12h: string;
      ggr_24h: string; ggr_3d: string; ggr_7d: string; ggr_30d: string; ggr_all: string;
      // Deposit COUNT (number of completed deposit transactions) per
      // period. Pairs with the existing revenue_* (sum) columns so the
      // Deposits KPI card can show "$X across N deposits" on the same
      // period selector.
      deposit_count_1h: string; deposit_count_3h: string; deposit_count_6h: string; deposit_count_12h: string;
      deposit_count_24h: string; deposit_count_3d: string; deposit_count_7d: string; deposit_count_30d: string; deposit_count_all: string;
      // 24h windowed balance-change components used by the dashboard's
      // realizedPnl24h figure. Computed off the same `base` CTE as the
      // rest, so they cost no extra round-trip. Replaces the four
      // separate queries that calculateWindowedPnl() used to fire just
      // to gather these two values.
      // `balance_change_24h` = sum of `balance_after − balance_before`
      // over completed ledger rows in the rolling last 24h.
      // `manual_wd_24h` = sum of `amount` for admin_balance_adjustment
      // rows that look like manual withdrawals (description-tagged) in
      // the same window — pulled out so the 24h withdrawals figure can
      // include manuals alongside the card-withdrawal value already
      // captured in `withdrawal_24h`.
      balance_change_24h: string;
      manual_wd_24h: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.role, u.referred_by,
             -- under_creator flags users who joined under an official
             -- creator code — referred_by points to a user with role
             -- 'creator'. NULL referred_by (organic signup) is false.
             -- Computed once per user here so the per-row CASE on the
             -- ledger scan stays cheap.
             EXISTS (
               SELECT 1 FROM "user" ref
               WHERE ref.id = u.referred_by AND ref.role = 'creator'
             ) AS under_creator
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
    base AS (
      -- in_session marks a wager a creator made while live on a deal/
      -- stream — its created_at falls inside one of that creator's
      -- session windows. Creators wager house-funded "sponsored"
      -- balance on stream, which is not a real customer bet, so the
      -- customer wager figure drops these rows. The CASE keeps the
      -- EXISTS subquery off the hot path for non-creator rows.
      -- lt_balance_*/lt_description are aliased through the CTE so the
      -- 24h balance-change + manual-withdrawal sums at the bottom of
      -- this SELECT can reach them without re-joining the ledger.
      -- under_creator carries forward whether the wagering user joined
      -- under an official creator code — drives the wager_organic_*
      -- aggregate at the bottom of the SELECT.
      SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, lt.created_at,
             lt.balance_after AS lt_balance_after,
             lt.balance_before AS lt_balance_before,
             lt.description AS lt_description,
             ru.under_creator,
             CASE WHEN ru.role = 'creator'
                  THEN EXISTS (
                    SELECT 1 FROM session_windows sw
                    WHERE sw.uid = lt.user_id
                      AND lt.created_at >= sw.win_start
                      AND lt.created_at <  sw.win_end
                  )
                  ELSE false END AS in_session
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed'
    ),
    withdrawals AS (
      SELECT
        total_value_usd::numeric AS amount,
        -- Use shipped_at as the "money out" timestamp when completed_at is
        -- not yet set (status='shipped'). For status='completed' both
        -- timestamps are usually populated; completed_at wins.
        COALESCE(completed_at, shipped_at) AS effective_at
      FROM card_withdrawal_requests
      WHERE status IN ('completed', 'shipped')
        AND user_id IN (SELECT id FROM real_users)
    )
    SELECT
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS revenue_1h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_3h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS revenue_6h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS revenue_12h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS revenue_24h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_3d,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_7d,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS revenue_30d,
      COALESCE(SUM(CASE WHEN type = 'deposit'                                    THEN amount ELSE 0 END), 0)::text AS revenue_all,

      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${oneHourAgo}     THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_1h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${threeHoursAgo}  THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_3h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${sixHoursAgo}    THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_6h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${twelveHoursAgo} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_12h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_24h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${threeDaysAgo}  THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_3d,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_7d,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_30d,
      COALESCE((SELECT SUM(amount)                                                            FROM withdrawals), 0)::text AS withdrawal_all,

      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS wager_1h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS wager_3h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_6h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS wager_12h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_24h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_3d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_7d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS wager_30d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')                                    THEN amount ELSE 0 END), 0)::text AS wager_all,

      -- Customer wager — the wager_* set MINUS wagers a creator made
      -- while live on a deal/stream (in_session). Creators wager
      -- house-funded "sponsored" balance on stream — recorded as
      -- ordinary pack_opening/battle_bet rows — which is not a real
      -- customer bet. A creator's OFF-session personal play stays in.
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS wager_excl_session_1h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS wager_excl_session_3h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_excl_session_6h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS wager_excl_session_12h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_excl_session_24h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_excl_session_3d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_excl_session_7d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS wager_excl_session_30d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session                                    THEN amount ELSE 0 END), 0)::text AS wager_excl_session_all,

      -- Packs vs Battles split of the customer wager. Both sums use
      -- the same NOT in_session filter and the same time windows as
      -- wager_excl_session_*, so pack + battle == wager_excl_session
      -- per window. Drives the "Packs / Battles / Upgrader" chip row
      -- under the Total Wager card (Upgrader stays 0 until that
      -- product surface exists on the main site).
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_1h,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_3h,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_6h,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_12h,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_24h,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_3d,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_7d,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_30d,
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session                                    THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session_all,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_1h,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_3h,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_6h,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_12h,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_24h,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_3d,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_7d,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_30d,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session                                    THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session_all,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_1h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_3h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_6h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_12h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_24h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_3d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_7d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_30d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session                                    THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session_all,

      -- Organic wager — pack / battle / upgrader wager from users who
      -- did NOT join under an official creator code (and isn't a
      -- creator's own on-stream play, via NOT in_session). Reads off
      -- the under_creator flag set on the real_users CTE above.
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${oneHourAgo}        THEN amount ELSE 0 END), 0)::text AS wager_organic_1h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${threeHoursAgo}     THEN amount ELSE 0 END), 0)::text AS wager_organic_3h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${sixHoursAgo}       THEN amount ELSE 0 END), 0)::text AS wager_organic_6h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${twelveHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_organic_12h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${twentyFourHoursAgo} THEN amount ELSE 0 END), 0)::text AS wager_organic_24h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${threeDaysAgo}     THEN amount ELSE 0 END), 0)::text AS wager_organic_3d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${sevenDaysAgo}     THEN amount ELSE 0 END), 0)::text AS wager_organic_7d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${thirtyDaysAgo}    THEN amount ELSE 0 END), 0)::text AS wager_organic_30d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator                                       THEN amount ELSE 0 END), 0)::text AS wager_organic_all,

      -- GGR = wagers − payouts (industry-standard pure gaming margin).
      -- The wager (ggrWagerIn) + payout (ggrPayoutIn) type sets are
      -- interpolated from the canonical shared constants in
      -- src/lib/queries/_wager-payout-types.ts (the same lists creators-pnl.ts
      -- uses), so the dashboard's global GGR can never drift from the
      -- per-creator GGR. Change the lists in that one file, not here.
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${oneHourAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${oneHourAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_1h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${threeHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${threeHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_3h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${sixHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${sixHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_6h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${twelveHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${twelveHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_12h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${twentyFourHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${twentyFourHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_24h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${threeDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${threeDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_3d,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${sevenDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${sevenDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_7d,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${thirtyDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${thirtyDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_30d,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_all,

      -- Deposit COUNT per period. Same window definitions as the
      -- revenue_* (sum) columns so the Deposits card can show both
      -- "$X" and "N deposits" on a single period selector. COUNT()
      -- with FILTER (CASE WHEN ... THEN 1 END) — only counts rows
      -- where the condition is true; null rows are skipped.
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${oneHourAgo}        THEN 1 END)::text AS deposit_count_1h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${threeHoursAgo}     THEN 1 END)::text AS deposit_count_3h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${sixHoursAgo}       THEN 1 END)::text AS deposit_count_6h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${twelveHoursAgo}    THEN 1 END)::text AS deposit_count_12h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${twentyFourHoursAgo} THEN 1 END)::text AS deposit_count_24h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${threeDaysAgo}      THEN 1 END)::text AS deposit_count_3d,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${sevenDaysAgo}      THEN 1 END)::text AS deposit_count_7d,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${thirtyDaysAgo}     THEN 1 END)::text AS deposit_count_30d,
      COUNT(CASE WHEN type = 'deposit'                                         THEN 1 END)::text AS deposit_count_all,

      -- 24h windowed balance-change + manual-withdrawal sums for the
      -- realizedPnl24h calculation. The base CTE is already filtered to
      -- staff+blacklist exclusion and status='completed', so these are
      -- free aggregates off the same scan — and they replace the
      -- 4-query calculateWindowedPnl(rolling24h) call we used to fire
      -- separately. balance_after − balance_before carries the signed
      -- delta on every completed row (deposits +, withdrawals/payouts −),
      -- so summing it across the window gives Δbalance directly.
      COALESCE(SUM(CASE
        WHEN created_at >= ${twentyFourHoursAgo}
        THEN (lt_balance_after - lt_balance_before)::numeric ELSE 0 END), 0)::text AS balance_change_24h,
      COALESCE(SUM(CASE
        WHEN type = 'admin_balance_adjustment'
             AND lt_description ILIKE 'Manual withdrawal:%'
             AND lt_balance_after < lt_balance_before
             AND created_at >= ${twentyFourHoursAgo}
        THEN amount ELSE 0 END), 0)::text AS manual_wd_24h
    FROM base
  `;
}

// Lifetime realized P&L lives in src/lib/queries/_realized-pnl.ts so the
// Analytics page can use the exact same definition. Do not inline it here.

/**
 * Per-request memoized. The dashboard page streams several independent
 * Suspense segments (KPI strips, charts, the activity count strip) that
 * each read these stats; `cache()` ensures the heavy 12-query aggregate
 * runs once per render, not once per segment. Cross-request caching is
 * intentionally omitted — these are live platform numbers and the page
 * already revalidates them via the 60s AutoRefresh.
 */
export const getDashboardStats = cache(async () => {
  return withTiming("dashboard.getDashboardStats", () => dashboardStatsInner());
});

async function dashboardStatsInner() {
  // Wall-clock start of the server-side compute. Returned as `queryMs`
  // (Date.now() − t0 just before the return) so the dashboard can show a
  // real "Loaded in N ms" indicator instead of a faked/animated one. This
  // measures the whole aggregate (exclusion-list resolution + the parallel
  // query batch + post-processing), which is exactly the latency an admin
  // perceives when the streamed KPI strips resolve.
  const t0 = Date.now();
  const db = await getDb();
  // Resolve the combined staff+blacklist filter ONCE per request so
  // every aggregate below applies the same exclusion set. The list is
  // cached via React `cache()` in fetch.ts → repeated invocations are
  // free.
  const [staffRelation, excluded, sessionWindowsCte] = await Promise.all([
    excludeStaffAndBlacklisted(),
    getExcludedUserIds(),
    // Creator deal/stream session windows (backend creators API;
    // 5-min cached, best-effort) — drives the customer-wager
    // exclusion in getPeriodAggregates.
    getCreatorSessionWindowsCte(),
  ]);
  // Inline SQL fragment for `AND id NOT IN (...)` for the raw queries
  // that already do role NOT IN ('admin','support'). Empty string when
  // nothing is blacklisted so the query stays valid.
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  const now = new Date();
  // UTC-anchored boundaries so the dashboard renders the same numbers no
  // matter which timezone the request happens to land in (Vercel functions
  // can run in any region). Mirrors the convention used by
  // src/lib/queries/_realized-pnl.ts and src/lib/balance-limits.ts.
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startOfWeek = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - now.getUTCDay(),
    ),
  );
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  const oneHourAgo = new Date(now.getTime() - 1 * MS_PER_HOUR);
  const threeHoursAgo = new Date(now.getTime() - 3 * MS_PER_HOUR);
  const sixHoursAgo = new Date(now.getTime() - 6 * MS_PER_HOUR);
  const twelveHoursAgo = new Date(now.getTime() - 12 * MS_PER_HOUR);
  const threeDaysAgo = new Date(now.getTime() - 3 * MS_PER_DAY);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
  // Rolling 24h cutoff (now − 24h, NOT UTC midnight). Used by every
  // "24h" surface on the dashboard:
  //   • Period aggregates (revenue / wager / GGR / withdrawal "24h" KPI cards)
  //   • The 24h Activity tile (pack openings + battles count)
  // The card chips next to "24h" are 1h / 3h / 6h / 12h / 3d / 7d / 30d
  // — all rolling. Making "24h" rolling too keeps the row coherent.
  const rolling24h = new Date(now.getTime() - 1 * MS_PER_DAY);

  // Perf audit (2026-05-27): cut the dashboard's parallel query batch
  // from 17 to 12 queries, and dropped the 4-query
  // calculateWindowedPnl() call for the 24h P&L. Net is roughly 9
  // fewer round-trips per dashboard refresh.
  // Dropped queries (the fields they fed were never read by the UI):
  //   • packStats         — stats.packs.* unused
  //   • activityTotals    — totalPacksOpened / totalBattlesPlayed unused
  //   • pendingWithdrawals — operations.* unused
  //   • active_users_24h column in periodAggregates — unused
  // Merges (same plan, fewer round-trips):
  //   • signups24h folded into userCounts (one user-table scan via
  //     FILTER blocks, same as today/week/month)
  //   • ftdResult (24h) + dailyFtds → one UNION ALL on a shared
  //     first_deposits CTE, so the lifetime DISTINCT ON scan runs once
  //   • dailyActiveDepositors folded into the dailyChart 30-day scan
  //     (same ledger rows, extra COUNT DISTINCT column)
  // Replacement of calculateWindowedPnl(24h):
  //   • The 24h components come from the existing periodAggregates
  //     query (revenue_24h, withdrawal_24h, balance_change_24h,
  //     manual_wd_24h) PLUS a single composite query for the 24h
  //     inventory + voucher deltas. Saves 2 ledger scans and 2
  //     parallel round-trips.
  const [
    userCounts,
    balanceAggregates,
    dailyChart,
    dailySignups,
    dailyWagerAttribution,
    periodAggregates,
    uniqueDepositorsResult,
    realizedPnlResult,
    totalInventoryValue,
    packsOpened24h,
    battlesPlayed24h,
    ftdCombined,
    windowed24hDelta,
  ] = await Promise.all([
    // All four user counts (total + today/week/month) PLUS the
    // rolling-24h signup count in ONE scan of the user table via
    // COUNT(*) FILTER. The 24h figure used to be a separate user.count
    // call.
    db.$queryRaw<{
      total: string;
      today: string;
      week: string;
      month: string;
      rolling24h: string;
    }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE created_at >= ${startOfDay})::text AS today,
        COUNT(*) FILTER (WHERE created_at >= ${startOfWeek})::text AS week,
        COUNT(*) FILTER (WHERE created_at >= ${startOfMonth})::text AS month,
        COUNT(*) FILTER (WHERE created_at >= ${rolling24h})::text AS rolling24h
      FROM "user"
      WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    `,
    // Single balances aggregate — `available_balance` is folded in with
    // the lifetime _sums so the dashboard pays one round-trip, not two.
    // The `Users Total Balance` tile + lifetime financial KPIs all draw
    // from this row.
    db.balances.aggregate({
      where: { user: staffRelation },
      _sum: {
        total_deposited: true,
        total_withdrawn: true,
        total_wagered: true,
        total_won: true,
        available_balance: true,
      },
    }),
    // Daily wager + deposit + active-depositor series for the last 30
    // days in ONE ledger scan. packs/battles feed the stacked wager bar
    // chart; deposits feeds the deposits line; active_depositors feeds
    // the Active Depositors chart. The last column used to be its own
    // 30-day ledger scan — merging saves one round-trip + one index
    // scan over the same rows.
    db.$queryRaw<{
      date: Date;
      packs: string;
      battles: string;
      upgrader: string;
      deposits: string;
      active_depositors: string;
    }[]>`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(CASE WHEN type = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as packs,
        COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text as battles,
        COALESCE(SUM(CASE WHEN type = 'upgrader_bet' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as upgrader,
        COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount::numeric ELSE 0 END), 0)::text as deposits,
        COUNT(DISTINCT CASE WHEN type = 'deposit' THEN user_id END)::text as active_depositors
      FROM ledger_transactions
      WHERE type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet','deposit') AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)})
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Signups last 30 days
    db.$queryRaw<{ date: Date; count: string }[]>`
      SELECT DATE(created_at) as date, COUNT(*)::text as count
      FROM "user"
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Daily wager attribution split — organic (no creator-code
    // referral) vs creator-attributed (referred by a creator role
    // user) — for the last 30 days. Excludes the creator role itself
    // and staff from BOTH sides so the two bars represent customer
    // wager only. Stacking organic + creator_attributed = total
    // customer wager.
    db.$queryRaw<{
      date: Date;
      organic: string;
      creator_attributed: string;
    }[]>`
      WITH customers AS (
        SELECT u.id,
               EXISTS (
                 SELECT 1 FROM "user" ref
                 WHERE ref.id = u.referred_by AND ref.role = 'creator'
               ) AS under_creator
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(blacklistIdNotIn)}
      )
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(CASE WHEN NOT c.under_creator THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS organic,
        COALESCE(SUM(CASE WHEN c.under_creator     THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS creator_attributed
      FROM ledger_transactions lt
      JOIN customers c ON c.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
        AND lt.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(lt.created_at)
      ORDER BY date
    `,
    // Single batched query replaces 20 independent aggregates (revenue,
    // withdrawal, wager, ggr × 5 periods each). Same plan + same index
    // scan — but one round-trip. Also produces `balance_change_24h` and
    // `manual_wd_24h` so the dashboard's 24h P&L no longer needs the
    // 4-query calculateWindowedPnl() call.
    getPeriodAggregates(db, oneHourAgo, threeHoursAgo, sixHoursAgo, twelveHoursAgo, rolling24h, threeDaysAgo, sevenDaysAgo, thirtyDaysAgo, blacklistIdNotIn, sessionWindowsCte),
    // Distinct depositors = real users whose LIFETIME completed-deposit
    // total is > 0. Read from `balances` (one row per user — thousands)
    // with the same staff+blacklist exclusion, instead of COUNT(DISTINCT
    // user_id) over every completed deposit ledger row (millions). Safe
    // equivalence: total_deposited is the authoritative lifetime deposit
    // sum the dashboard already trusts (avgDeposit / totalDeposited).
    db.balances.count({
      where: { total_deposited: { gt: 0 }, user: staffRelation },
    }),
    getRealizedPnlSnapshot(),
    db.user_inventory.aggregate({
      where: {
        sold_at: null,
        exchanged_at: null,
        // Exclude items that are locked for a pending card withdrawal —
        // they are effectively "on their way out" of the user's on-site
        // holdings and shouldn't inflate the aggregate balance.
        withdrawal_locked_at: null,
        user: staffRelation,
      },
      _sum: { value_at_obtained: true },
    }),
    // Rolling-24h pack opening count for the "24h Activity" tile.
    // Filter game_sessions by game_type='pack' to match the same
    // definition the existing pack profitability queries use.
    db.game_sessions.count({
      where: {
        game_type: "pack",
        created_at: { gte: rolling24h },
        user: staffRelation,
      },
    }),
    // Rolling-24h battle count — counts battles created in the last 24h
    // regardless of status (started = counts as "happened today").
    // `user` on battles points to the battle creator; that's the row we
    // exclude staff/blacklist on (matching the staff-exclusion in every
    // other dashboard aggregate).
    db.battles.count({
      where: {
        created_at: { gte: rolling24h },
        user: staffRelation,
      },
    }),
    // FTDs combined — rolling-24h figure (count + total) + per-day
    // counts/totals for the last 30 days, sharing a single
    // first_deposits CTE. Previously two separate queries that each
    // re-ran the lifetime DISTINCT ON scan. The UNION ALL keeps the
    // rolling row distinguished by a `tag` column (NULL bucket on the
    // 24h row; one row per day on the 'daily' rows). Same "first
    // deposit" definition the fraud scorer uses.
    db.$queryRaw<{
      tag: string;
      bucket: Date | null;
      count: string;
      total: string;
    }[]>`
      WITH first_deposits AS (
        SELECT DISTINCT ON (user_id)
          user_id, amount::numeric AS amount, created_at
        FROM ledger_transactions
        WHERE type = 'deposit' AND status = 'completed'
          AND user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ORDER BY user_id, created_at ASC
      )
      SELECT 'rolling24h'::text AS tag,
             NULL::date AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= ${rolling24h}
      UNION ALL
      SELECT 'daily'::text AS tag,
             DATE(created_at) AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
    `,
    // 24h windowed inventory + voucher deltas. The other three
    // components of the 24h P&L (deposits, card-withdrawals, ledger
    // balance change, manual withdrawals) already come from
    // periodAggregates / the realized snapshot — these are the two
    // pieces it doesn't carry, so we fetch them in one composite query
    // instead of as part of calculateWindowedPnl's 4-query bundle. Each
    // subselect is a narrow indexed range scan; PG materializes the
    // common `real_users` CTE once.
    db.$queryRaw<{
      inv_obtained: string;
      inv_disposed: string;
      vch_issued: string;
      vch_claimed: string;
    }[]>`
      WITH real_users AS (
        SELECT id FROM "user"
        WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      )
      SELECT
        COALESCE((SELECT SUM(value_at_obtained::numeric) FROM user_inventory
          WHERE obtained_at >= ${rolling24h}
            AND user_id IN (SELECT id FROM real_users)), 0)::text AS inv_obtained,
        COALESCE((SELECT SUM(value_at_obtained::numeric) FROM user_inventory
          WHERE (sold_at >= ${rolling24h} OR exchanged_at >= ${rolling24h})
            AND user_id IN (SELECT id FROM real_users)), 0)::text AS inv_disposed,
        COALESCE((SELECT SUM(value::numeric) FROM vouchers
          WHERE created_at >= ${rolling24h}
            AND user_id IN (SELECT id FROM real_users)), 0)::text AS vch_issued,
        COALESCE((SELECT SUM(value::numeric) FROM vouchers
          WHERE claimed_at >= ${rolling24h}
            AND user_id IN (SELECT id FROM real_users)), 0)::text AS vch_claimed
    `,
  ]);

  const totalWagered = toNumber(balanceAggregates._sum?.total_wagered);
  const totalWon = toNumber(balanceAggregates._sum?.total_won);

  // Unpack the batched period aggregates. Each field is a text-encoded
  // numeric; parseFloat() is sufficient because we're always going
  // through Number coercion anyway downstream.
  const pa = periodAggregates[0] ?? {
    revenue_1h: "0", revenue_3h: "0", revenue_6h: "0", revenue_12h: "0",
    revenue_24h: "0", revenue_3d: "0", revenue_7d: "0", revenue_30d: "0", revenue_all: "0",
    withdrawal_1h: "0", withdrawal_3h: "0", withdrawal_6h: "0", withdrawal_12h: "0",
    withdrawal_24h: "0", withdrawal_3d: "0", withdrawal_7d: "0", withdrawal_30d: "0", withdrawal_all: "0",
    wager_1h: "0", wager_3h: "0", wager_6h: "0", wager_12h: "0",
    wager_24h: "0", wager_3d: "0", wager_7d: "0", wager_30d: "0", wager_all: "0",
    wager_excl_session_1h: "0", wager_excl_session_3h: "0", wager_excl_session_6h: "0", wager_excl_session_12h: "0",
    wager_excl_session_24h: "0", wager_excl_session_3d: "0", wager_excl_session_7d: "0", wager_excl_session_30d: "0", wager_excl_session_all: "0",
    pack_wager_excl_session_1h: "0", pack_wager_excl_session_3h: "0", pack_wager_excl_session_6h: "0", pack_wager_excl_session_12h: "0",
    pack_wager_excl_session_24h: "0", pack_wager_excl_session_3d: "0", pack_wager_excl_session_7d: "0", pack_wager_excl_session_30d: "0", pack_wager_excl_session_all: "0",
    battle_wager_excl_session_1h: "0", battle_wager_excl_session_3h: "0", battle_wager_excl_session_6h: "0", battle_wager_excl_session_12h: "0",
    battle_wager_excl_session_24h: "0", battle_wager_excl_session_3d: "0", battle_wager_excl_session_7d: "0", battle_wager_excl_session_30d: "0", battle_wager_excl_session_all: "0",
    upgrader_wager_excl_session_1h: "0", upgrader_wager_excl_session_3h: "0", upgrader_wager_excl_session_6h: "0", upgrader_wager_excl_session_12h: "0",
    upgrader_wager_excl_session_24h: "0", upgrader_wager_excl_session_3d: "0", upgrader_wager_excl_session_7d: "0", upgrader_wager_excl_session_30d: "0", upgrader_wager_excl_session_all: "0",
    wager_organic_1h: "0", wager_organic_3h: "0", wager_organic_6h: "0", wager_organic_12h: "0",
    wager_organic_24h: "0", wager_organic_3d: "0", wager_organic_7d: "0", wager_organic_30d: "0", wager_organic_all: "0",
    ggr_1h: "0", ggr_3h: "0", ggr_6h: "0", ggr_12h: "0",
    ggr_24h: "0", ggr_3d: "0", ggr_7d: "0", ggr_30d: "0", ggr_all: "0",
    deposit_count_1h: "0", deposit_count_3h: "0", deposit_count_6h: "0", deposit_count_12h: "0",
    deposit_count_24h: "0", deposit_count_3d: "0", deposit_count_7d: "0", deposit_count_30d: "0", deposit_count_all: "0",
    balance_change_24h: "0",
    manual_wd_24h: "0",
  };
  const num = (s: string) => parseFloat(s) || 0;
  // Lifetime deposit transaction count — reused from the period
  // aggregates CTE (column `deposit_count_all`) so we don't pay a
  // dedicated `ledger_transactions.count()` round-trip just for this.
  const depositCount = num(pa.deposit_count_all);

  // FTD rows come back via UNION: one 'rolling24h' row (bucket = NULL)
  // and many 'daily' rows (bucket = a calendar date) — see the
  // ftdCombined query above. Splitting them out here keeps the two
  // downstream consumers (ftds24h tile + dailyFtds chart) clean.
  const ftdRolling = ftdCombined.find((r) => r.tag === "rolling24h");
  const ftdDailyRows = ftdCombined
    .filter((r) => r.tag === "daily" && r.bucket !== null)
    .sort((a, b) => {
      // ascending by date — `bucket` is a Date or an ISO string from
      // node-postgres depending on driver version, so we normalise.
      const ta = new Date(a.bucket as Date | string).getTime();
      const tb = new Date(b.bucket as Date | string).getTime();
      return ta - tb;
    });
  const ftdCount = Number(ftdRolling?.count ?? 0);
  const ftdTotal = Number(ftdRolling?.total ?? 0);

  // 24h windowed house P&L — derived from existing aggregates instead
  // of a separate calculateWindowedPnl() call. The 4 queries that
  // function used to fire are now covered by:
  //   • deposits_24h        ← pa.revenue_24h
  //   • card-withdrawal_24h ← pa.withdrawal_24h
  //   • balance_change_24h  ← pa.balance_change_24h (new column)
  //   • manual_wd_24h       ← pa.manual_wd_24h (new column)
  //   • inv/voucher Δ_24h   ← windowed24hDelta (single composite query)
  // Formula matches calculateWindowedPnl exactly:
  //   pnl = deposits − (manualWd + cardWd) − balanceChange − Δinv − Δvch
  const deposits24h = num(pa.revenue_24h);
  const cardWd24h = Math.abs(num(pa.withdrawal_24h));
  const manualWd24h = num(pa.manual_wd_24h);
  const balanceChange24h = num(pa.balance_change_24h);
  const wd = windowed24hDelta[0] ?? {
    inv_obtained: "0",
    inv_disposed: "0",
    vch_issued: "0",
    vch_claimed: "0",
  };
  const inventoryChange24h = num(wd.inv_obtained) - num(wd.inv_disposed);
  const voucherChange24h = num(wd.vch_issued) - num(wd.vch_claimed);
  const realizedPnl24h =
    deposits24h -
    (manualWd24h + cardWd24h) -
    balanceChange24h -
    inventoryChange24h -
    voucherChange24h;

  return {
    users: {
      total: Number(userCounts[0]?.total ?? 0),
      today: Number(userCounts[0]?.today ?? 0),
      week: Number(userCounts[0]?.week ?? 0),
      month: Number(userCounts[0]?.month ?? 0),
    },
    // Gaming margin (wagers − payouts) per period. Pure GGR, no liability
    // adjustment. Use realizedPnl for the balance-sheet-true number.
    ggr: {
      "1h": num(pa.ggr_1h),
      "3h": num(pa.ggr_3h),
      "6h": num(pa.ggr_6h),
      "12h": num(pa.ggr_12h),
      "24h": num(pa.ggr_24h),
      "3d": num(pa.ggr_3d),
      "7d": num(pa.ggr_7d),
      "30d": num(pa.ggr_30d),
      all: num(pa.ggr_all),
    },
    // Lifetime realized P&L from the house perspective — see getRealizedPnlSnapshot.
    // This is a single snapshot value, not a period series.
    realizedPnl: realizedPnlResult.pnl,
    // Rolling past-24h house P&L (windowed delta — same formula as
    // calculateWindowedPnl but computed inline here from pieces that
    // periodAggregates + the windowed24hDelta query already produce).
    realizedPnl24h,
    deposits: {
      "1h": num(pa.revenue_1h),
      "3h": num(pa.revenue_3h),
      "6h": num(pa.revenue_6h),
      "12h": num(pa.revenue_12h),
      "24h": num(pa.revenue_24h),
      "3d": num(pa.revenue_3d),
      "7d": num(pa.revenue_7d),
      "30d": num(pa.revenue_30d),
      all: num(pa.revenue_all),
    },
    // Deposit COUNT (number of completed deposit transactions) per
    // period. Same window definitions as `deposits` above — they pair
    // 1:1 so the Deposits KPI card can show "$X across N deposits"
    // synced to a single period selector.
    depositCounts: {
      "1h": num(pa.deposit_count_1h),
      "3h": num(pa.deposit_count_3h),
      "6h": num(pa.deposit_count_6h),
      "12h": num(pa.deposit_count_12h),
      "24h": num(pa.deposit_count_24h),
      "3d": num(pa.deposit_count_3d),
      "7d": num(pa.deposit_count_7d),
      "30d": num(pa.deposit_count_30d),
      all: num(pa.deposit_count_all),
    },
    // Sourced from card_withdrawal_requests (status IN completed/shipped)
    // so the StatCard matches the PnL formula. Values are already positive
    // outflow magnitudes; Math.abs is a defensive no-op.
    withdrawals: {
      "1h": Math.abs(num(pa.withdrawal_1h)),
      "3h": Math.abs(num(pa.withdrawal_3h)),
      "6h": Math.abs(num(pa.withdrawal_6h)),
      "12h": Math.abs(num(pa.withdrawal_12h)),
      "24h": Math.abs(num(pa.withdrawal_24h)),
      "3d": Math.abs(num(pa.withdrawal_3d)),
      "7d": Math.abs(num(pa.withdrawal_7d)),
      "30d": Math.abs(num(pa.withdrawal_30d)),
      all: Math.abs(num(pa.withdrawal_all)),
    },
    // Customer wager — wagers a creator made while live on a deal/stream
    // are EXCLUDED (house-funded "sponsored" play, not a real customer
    // bet). A creator's off-session personal play is kept. This is the
    // figure the dashboard's "Total Wager" card shows.
    wagers: {
      "1h": Math.abs(num(pa.wager_excl_session_1h)),
      "3h": Math.abs(num(pa.wager_excl_session_3h)),
      "6h": Math.abs(num(pa.wager_excl_session_6h)),
      "12h": Math.abs(num(pa.wager_excl_session_12h)),
      "24h": Math.abs(num(pa.wager_excl_session_24h)),
      "3d": Math.abs(num(pa.wager_excl_session_3d)),
      "7d": Math.abs(num(pa.wager_excl_session_7d)),
      "30d": Math.abs(num(pa.wager_excl_session_30d)),
      all: Math.abs(num(pa.wager_excl_session_all)),
    },
    // Per-source breakdown of the customer wager. Packs + Battles +
    // Upgrader add up to `wagers` per window. All three are sourced
    // from the same NOT in_session filter as wager_excl_session_*, so
    // creator on-stream play is excluded consistently across surfaces.
    wagersBreakdown: {
      packs: {
        "1h": Math.abs(num(pa.pack_wager_excl_session_1h)),
        "3h": Math.abs(num(pa.pack_wager_excl_session_3h)),
        "6h": Math.abs(num(pa.pack_wager_excl_session_6h)),
        "12h": Math.abs(num(pa.pack_wager_excl_session_12h)),
        "24h": Math.abs(num(pa.pack_wager_excl_session_24h)),
        "3d": Math.abs(num(pa.pack_wager_excl_session_3d)),
        "7d": Math.abs(num(pa.pack_wager_excl_session_7d)),
        "30d": Math.abs(num(pa.pack_wager_excl_session_30d)),
        all: Math.abs(num(pa.pack_wager_excl_session_all)),
      },
      battles: {
        "1h": Math.abs(num(pa.battle_wager_excl_session_1h)),
        "3h": Math.abs(num(pa.battle_wager_excl_session_3h)),
        "6h": Math.abs(num(pa.battle_wager_excl_session_6h)),
        "12h": Math.abs(num(pa.battle_wager_excl_session_12h)),
        "24h": Math.abs(num(pa.battle_wager_excl_session_24h)),
        "3d": Math.abs(num(pa.battle_wager_excl_session_3d)),
        "7d": Math.abs(num(pa.battle_wager_excl_session_7d)),
        "30d": Math.abs(num(pa.battle_wager_excl_session_30d)),
        all: Math.abs(num(pa.battle_wager_excl_session_all)),
      },
      upgrader: {
        "1h": Math.abs(num(pa.upgrader_wager_excl_session_1h)),
        "3h": Math.abs(num(pa.upgrader_wager_excl_session_3h)),
        "6h": Math.abs(num(pa.upgrader_wager_excl_session_6h)),
        "12h": Math.abs(num(pa.upgrader_wager_excl_session_12h)),
        "24h": Math.abs(num(pa.upgrader_wager_excl_session_24h)),
        "3d": Math.abs(num(pa.upgrader_wager_excl_session_3d)),
        "7d": Math.abs(num(pa.upgrader_wager_excl_session_7d)),
        "30d": Math.abs(num(pa.upgrader_wager_excl_session_30d)),
        all: Math.abs(num(pa.upgrader_wager_excl_session_all)),
      },
    },
    // Organic wager — customer wager from users who did NOT join under
    // an official creator code (referrer is null or a non-creator
    // user). Excludes creator on-stream play via the same NOT
    // in_session filter as `wagers`. Surfaces the wager volume not
    // attributed to creator marketing.
    wagersOrganic: {
      "1h": Math.abs(num(pa.wager_organic_1h)),
      "3h": Math.abs(num(pa.wager_organic_3h)),
      "6h": Math.abs(num(pa.wager_organic_6h)),
      "12h": Math.abs(num(pa.wager_organic_12h)),
      "24h": Math.abs(num(pa.wager_organic_24h)),
      "3d": Math.abs(num(pa.wager_organic_3d)),
      "7d": Math.abs(num(pa.wager_organic_7d)),
      "30d": Math.abs(num(pa.wager_organic_30d)),
      all: Math.abs(num(pa.wager_organic_all)),
    },
    // Raw wager — every non-staff user, INCLUDING creators' on-stream
    // sponsored play. The "Raw Wager" card shows this; (wagersRaw −
    // wagers) is the creator deal/stream sponsored-balance contribution.
    wagersRaw: {
      "1h": Math.abs(num(pa.wager_1h)),
      "3h": Math.abs(num(pa.wager_3h)),
      "6h": Math.abs(num(pa.wager_6h)),
      "12h": Math.abs(num(pa.wager_12h)),
      "24h": Math.abs(num(pa.wager_24h)),
      "3d": Math.abs(num(pa.wager_3d)),
      "7d": Math.abs(num(pa.wager_7d)),
      "30d": Math.abs(num(pa.wager_30d)),
      all: Math.abs(num(pa.wager_all)),
    },
    financials: {
      totalDeposited: toNumber(balanceAggregates._sum?.total_deposited),
      totalWithdrawn: toNumber(balanceAggregates._sum?.total_withdrawn),
      totalWagered,
      totalWon,
      // `available_balance` lives on the merged balanceAggregates row
      // (was a second `.aggregate()` call previously — folded into one
      // round-trip during the 2026-05-11 perf pass).
      totalSiteBalance: toNumber(balanceAggregates._sum?.available_balance),
      totalInventoryValue: toNumber(totalInventoryValue._sum?.value_at_obtained),
      // Outstanding (unclaimed) voucher liability — the third leg of the
      // house's balance liability alongside on-site cash + held inventory.
      // Pulled from the realized-P&L snapshot (already fetched + React-
      // cached above), so this adds no extra round-trip and uses the SAME
      // staff+blacklist exclusion. The dashboard previously surfaced only
      // cash + inventory in "Users Total Balance"; vouchers were tracked
      // inside realizedPnl but never shown as part of the liability total.
      totalUnclaimedVouchers: realizedPnlResult.vouchers,
      avgDeposit:
        depositCount > 0
          ? toNumber(balanceAggregates._sum?.total_deposited) / depositCount
          : 0,
      depositCount,
      // Unique players who have ever completed at least one deposit
      // (real users only; staff excluded via EXCLUDE_STAFF). Distinct
      // from depositCount above which counts deposit transactions —
      // a single user with five deposits = depositCount 5,
      // uniqueDepositors 1.
      uniqueDepositors: uniqueDepositorsResult,
      // First-time depositors in the rolling last 24h: count, the
      // summed value of those first deposits, and the average. The 24h
      // counterpart to uniqueDepositors (lifetime distinct depositors).
      ftds24h: ftdCount,
      ftdTotal24h: ftdTotal,
      ftdAvg24h: ftdCount > 0 ? ftdTotal / ftdCount : 0,
    },
    activity: {
      // Rolling 24h counts — drive the Recent Activity stats strip.
      // Real users only; admins / support / blacklisted accounts excluded.
      // signups24h now comes from the merged userCounts query (one
      // user-table scan instead of two).
      packsOpened24h,
      battlesPlayed24h,
      signups24h: Number(userCounts[0]?.rolling24h ?? 0),
    },
    dailyWagers: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      packs: Number(d.packs),
      battles: Number(d.battles),
      upgrader: Number(d.upgrader),
    })),
    dailyDeposits: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      amount: Math.abs(Number(d.deposits)),
    })),
    dailySignups: dailySignups.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.count),
    })),
    // Daily FTDs — count + summed first-deposit value per day, plus the
    // derived average (total / count, guarded against div-by-zero).
    // Sourced from the ftdCombined UNION rows tagged 'daily'.
    dailyFtds: ftdDailyRows.map((d) => {
      const count = Number(d.count);
      const total = Number(d.total);
      return {
        date: new Date(d.bucket as Date | string).toISOString().split("T")[0],
        count,
        total,
        avg: count > 0 ? total / count : 0,
      };
    }),
    // Daily Active Depositors — distinct users who deposited each day
    // in the last 30 days. Sourced from the dailyChart 30-day ledger
    // scan (active_depositors column), which used to be a separate
    // 30-day scan.
    dailyActiveDepositors: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.active_depositors),
    })),
    // Daily Wager Attribution — organic (customers without a
    // creator-code referral) vs creator-coded (customers whose
    // referrer is a creator) per day for the last 30 days. The two
    // stack to the day's total customer wager. Excludes the creator
    // role itself + staff on both sides so neither bucket carries
    // creator-on-stream play.
    dailyWagerAttribution: dailyWagerAttribution.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      organic: Number(d.organic),
      creatorCoded: Number(d.creator_attributed),
    })),
    // Server-side compute metadata. `queryMs` is the wall-clock time spent
    // in this function (exclusion lists + the parallel query batch + the
    // light post-processing above) — measured here at the very end so it
    // reflects the whole aggregate. `generatedAt` is the moment the data
    // was produced, for a "updated Ns ago" relative label. Both are plain
    // serializable primitives → safe across the RSC boundary.
    queryMs: Date.now() - t0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Lightweight snapshot of the CURRENT rain for the dashboard's live box.
 * Deliberately NOT part of getDashboardStats — it's a single indexed row
 * lookup, so it streams behind its own Suspense and refreshes on the 60s
 * dashboard tick without adding to the heavy aggregate's query time.
 *
 * "Current" = the rain that's still in play: `active` (accepting entries)
 * or `drawing` (entries closed, picking a winner). Most recent by
 * starts_at. Returns null between rains (UI shows an idle state).
 * Participant count is read straight off rains.participant_count (kept in
 * sync by the main site), which equals the rain_entries head-count.
 */
export type ActiveRainSummary = {
  id: string;
  participantCount: number;
  totalPoolUsd: number;
  baseAmountUsd: number;
  tipAmountUsd: number;
  status: string;
  startsAt: string;
  endsAt: string;
} | null;

export async function getActiveRain(): Promise<ActiveRainSummary> {
  const db = await getDb();
  const rain = await db.rains.findFirst({
    where: { status: { in: ["active", "drawing"] } },
    orderBy: { starts_at: "desc" },
    select: {
      id: true,
      participant_count: true,
      total_pool_usd: true,
      base_amount_usd: true,
      tip_amount_usd: true,
      status: true,
      starts_at: true,
      ends_at: true,
    },
  });
  if (!rain) return null;
  return {
    id: rain.id,
    participantCount: rain.participant_count,
    totalPoolUsd: toNumber(rain.total_pool_usd),
    baseAmountUsd: toNumber(rain.base_amount_usd),
    tipAmountUsd: toNumber(rain.tip_amount_usd),
    status: rain.status,
    startsAt: rain.starts_at.toISOString(),
    endsAt: rain.ends_at.toISOString(),
  };
}
