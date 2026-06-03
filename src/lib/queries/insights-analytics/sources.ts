import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { periodToDays, type InsightsPeriod } from "@/app/(admin)/insights/analytics/types";

/**
 * Signup source breakdown. Two sub-tabs:
 *   • "buckets" — 3 buckets (organic / creator-affiliate / regular-
 *                  affiliate). Cohort metrics per bucket: signups,
 *                  first deposit, first wager, MAW, GGR, deposits.
 *   • "codes"   — per affiliate code: signups, first deposit %, GGR
 *                  driven, top 25 codes by signups in period.
 *
 * Staff (admin/support) + manual blacklist excluded.
 */

export type SourcesSubTab = "buckets" | "codes";

export function parseSourcesSubTab(value: string | undefined): SourcesSubTab {
  return value === "codes" ? "codes" : "buckets";
}

export type SourceBucketRow = {
  key: string;
  label: string;
  signups: number;
  firstDeposit: number;
  firstWager: number;
  maw: number;
  ggrDriven: number;
  depositsDriven: number;
  wagerDriven: number;
  // Per-user averages
  avgGgr: number;
};

export type SourceCodeRow = {
  code: string;
  affiliateUserId: string | null;
  signups: number;
  firstDeposit: number;
  ggrDriven: number;
  wagerDriven: number;
};

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout','card_sale','reward_card_sale')`;
const MAW_CUTOFF_DAYS = 30;

export async function getSourcesBuckets(
  period: InsightsPeriod,
): Promise<SourceBucketRow[]> {
  const db = await getDb();
  const days = periodToDays(period);
  const usersDateFilter =
    days !== null ? `AND u.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const ledgerDateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  const groupExpr = `
    CASE
      WHEN u.referred_by IS NULL THEN 'organic'
      WHEN EXISTS (SELECT 1 FROM "user" ref WHERE ref.id = u.referred_by AND ref.role = 'creator')
        THEN 'creator-affiliate'
      ELSE 'regular-affiliate'
    END
  `;

  const rows = await db.$queryRawUnsafe<
    {
      bucket: string;
      signups: string;
      first_deposit: string;
      first_wager: string;
      maw: string;
      ggr: string;
      deposits: string;
      wager: string;
    }[]
  >(`
    WITH cohort AS (
      SELECT u.id, (${groupExpr}) AS bucket
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${usersDateFilter}
    ),
    activity AS (
      SELECT
        c.id AS user_id,
        c.bucket,
        COUNT(*) FILTER (WHERE lt.type::text = 'deposit' AND lt.status = 'completed') AS deposit_count,
        COUNT(*) FILTER (WHERE lt.type::text IN ${WAGER_TYPES_SQL}
          AND lt.status = 'completed') AS wager_count,
        COUNT(*) FILTER (WHERE lt.type::text IN ${WAGER_TYPES_SQL}
          AND lt.status = 'completed'
          AND lt.created_at >= NOW() - INTERVAL '${MAW_CUTOFF_DAYS} days') AS wager_count_30d,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${WAGER_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_in_period,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${PAYOUT_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payouts_in_period,
        COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' AND lt.status = 'completed' ${ledgerDateFilter}
          THEN lt.amount::numeric ELSE 0 END), 0) AS deposits_in_period
      FROM cohort c
      LEFT JOIN ledger_transactions lt ON lt.user_id = c.id
      GROUP BY c.id, c.bucket
    )
    SELECT
      bucket,
      COUNT(*)::text AS signups,
      COUNT(*) FILTER (WHERE deposit_count > 0)::text AS first_deposit,
      COUNT(*) FILTER (WHERE wager_count > 0)::text AS first_wager,
      COUNT(*) FILTER (WHERE wager_count_30d > 0)::text AS maw,
      COALESCE(SUM(wager_in_period - payouts_in_period), 0)::text AS ggr,
      COALESCE(SUM(deposits_in_period), 0)::text AS deposits,
      COALESCE(SUM(wager_in_period), 0)::text AS wager
    FROM activity
    GROUP BY bucket
    ORDER BY signups DESC
  `);

  return rows.map((r) => {
    const signups = Number(r.signups);
    const ggr = toNumber(r.ggr);
    return {
      key: r.bucket,
      label:
        r.bucket === "organic"
          ? "Organic"
          : r.bucket === "creator-affiliate"
            ? "Creator affiliate"
            : "Regular affiliate",
      signups,
      firstDeposit: Number(r.first_deposit),
      firstWager: Number(r.first_wager),
      maw: Number(r.maw),
      ggrDriven: ggr,
      depositsDriven: toNumber(r.deposits),
      wagerDriven: toNumber(r.wager),
      avgGgr: signups > 0 ? ggr / signups : 0,
    };
  });
}

export async function getSourcesCodes(period: InsightsPeriod): Promise<SourceCodeRow[]> {
  const db = await getDb();
  const days = periodToDays(period);
  const usersDateFilter =
    days !== null ? `AND u.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const ledgerDateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Per-code aggregate. Codes here come from the `referred_by` lineage
  // (which references a user with an affiliate_code). The affiliate
  // code itself lives on the User row, so we join from the referred
  // user back through referred_by → user.affiliate_code.
  const rows = await db.$queryRawUnsafe<
    {
      code: string;
      affiliate_user_id: string;
      signups: string;
      first_deposit: string;
      ggr: string;
      wager: string;
    }[]
  >(`
    WITH cohort AS (
      SELECT u.id, u.referred_by, ref.affiliate_code, ref.id AS affiliate_user_id
      FROM "user" u
      JOIN "user" ref ON ref.id = u.referred_by
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND ref.affiliate_code IS NOT NULL
        ${usersDateFilter}
    ),
    activity AS (
      SELECT
        c.id AS user_id,
        c.affiliate_code AS code,
        c.affiliate_user_id,
        COUNT(*) FILTER (WHERE lt.type::text = 'deposit' AND lt.status = 'completed') AS deposit_count,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${WAGER_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_in_period,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${PAYOUT_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payouts_in_period
      FROM cohort c
      LEFT JOIN ledger_transactions lt ON lt.user_id = c.id
      GROUP BY c.id, c.affiliate_code, c.affiliate_user_id
    )
    SELECT
      code,
      affiliate_user_id,
      COUNT(*)::text AS signups,
      COUNT(*) FILTER (WHERE deposit_count > 0)::text AS first_deposit,
      COALESCE(SUM(wager_in_period - payouts_in_period), 0)::text AS ggr,
      COALESCE(SUM(wager_in_period), 0)::text AS wager
    FROM activity
    GROUP BY code, affiliate_user_id
    ORDER BY signups DESC
    LIMIT 25
  `);

  return rows.map((r) => ({
    code: r.code,
    affiliateUserId: r.affiliate_user_id ?? null,
    signups: Number(r.signups),
    firstDeposit: Number(r.first_deposit),
    ggrDriven: toNumber(r.ggr),
    wagerDriven: toNumber(r.wager),
  }));
}
