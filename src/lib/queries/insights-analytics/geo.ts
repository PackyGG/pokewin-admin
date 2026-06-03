import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { periodToDays, type InsightsPeriod } from "@/app/(admin)/insights/analytics/types";

/**
 * Geographic breakdown. Groups can be country (default), continent,
 * or state (limited to US for now — state column is sparsely populated
 * elsewhere).
 *
 * Per group we compute users, signups, deposits, wager, GGR, withdrawals.
 *
 * Period scopes deposits / wager / GGR / withdrawals only — `users` is
 * always the lifetime distinct count for the group (so admins can see
 * "we have N users from this country" alongside "they wagered $X in the
 * period").
 */

export type GeoGroupBy = "country" | "continent" | "state";

export function parseGeoGroupBy(value: string | undefined): GeoGroupBy {
  return value === "continent" || value === "state" ? value : "country";
}

export type GeoRow = {
  key: string;
  label: string;
  countryCode: string | null;
  users: number;
  signups: number;
  deposits: number;
  withdrawals: number;
  wager: number;
  ggr: number;
};

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout','card_sale','reward_card_sale')`;

export async function getInsightsGeo(
  period: InsightsPeriod,
  groupBy: GeoGroupBy,
): Promise<{ rows: GeoRow[]; groupBy: GeoGroupBy }> {
  const db = await getDb();
  const days = periodToDays(period);
  const periodFilter = days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const periodFilterSignups =
    days !== null ? `AND u.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const withdrawalFilter =
    days !== null
      ? `AND COALESCE(cwr.completed_at, cwr.shipped_at) >= NOW() - INTERVAL '${days} days'`
      : "";
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // GroupExpr — country code uses (country, country_code) so the UI can
  // render the ISO code chip. Continent groups by continent_code.
  // State filters to US (state is mainly populated for US users).
  const groupExpr = (() => {
    switch (groupBy) {
      case "country":
        return "COALESCE(u.country, 'Unknown'), u.country_code";
      case "continent":
        return "u.continent_code, NULL::text";
      case "state":
        return "COALESCE(u.state, 'Unknown'), u.country_code";
    }
  })();

  const groupKeyExpr = (() => {
    switch (groupBy) {
      case "country":
        return "COALESCE(u.country, 'Unknown')";
      case "continent":
        return "u.continent_code";
      case "state":
        return "COALESCE(u.state, 'Unknown')";
    }
  })();

  const stateFilter = groupBy === "state" ? "AND u.country_code = 'US'" : "";

  // Three raws: users (lifetime), wager/ggr/deposits in period, withdrawals
  // in period. Joining them in code via a Map is cheaper than a single
  // monster query.
  const [usersRows, ledgerRows, withdrawalRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        bucket: string;
        country_code: string | null;
        users: string;
        signups: string;
      }[]
    >(`
      SELECT
        ${groupKeyExpr} AS bucket,
        MAX(u.country_code) AS country_code,
        COUNT(*)::text AS users,
        COUNT(*) FILTER (WHERE 1=1 ${periodFilterSignups.replace("AND ", "AND ")})::text AS signups
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${stateFilter}
      GROUP BY ${groupExpr}
    `),
    db.$queryRawUnsafe<
      {
        bucket: string;
        deposits: string;
        wager: string;
        payouts: string;
      }[]
    >(`
      SELECT
        ${groupKeyExpr} AS bucket,
        COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${WAGER_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS wager,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${PAYOUT_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS payouts
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${stateFilter}
        ${periodFilter}
      GROUP BY ${groupKeyExpr}
    `),
    db.$queryRawUnsafe<
      {
        bucket: string;
        amount: string;
      }[]
    >(`
      SELECT
        ${groupKeyExpr} AS bucket,
        COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS amount
      FROM card_withdrawal_requests cwr
      JOIN "user" u ON u.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${stateFilter}
        ${withdrawalFilter}
      GROUP BY ${groupKeyExpr}
    `),
  ]);

  const byBucket = new Map<string, GeoRow>();
  for (const r of usersRows) {
    const bucket = r.bucket ?? "Unknown";
    byBucket.set(bucket, {
      key: bucket,
      label: bucket,
      countryCode: r.country_code ?? null,
      users: Number(r.users),
      signups: Number(r.signups),
      deposits: 0,
      withdrawals: 0,
      wager: 0,
      ggr: 0,
    });
  }
  for (const r of ledgerRows) {
    const bucket = r.bucket ?? "Unknown";
    const entry = byBucket.get(bucket);
    if (!entry) continue;
    entry.deposits = toNumber(r.deposits);
    entry.wager = toNumber(r.wager);
    entry.ggr = entry.wager - toNumber(r.payouts);
  }
  for (const r of withdrawalRows) {
    const bucket = r.bucket ?? "Unknown";
    const entry = byBucket.get(bucket);
    if (!entry) continue;
    entry.withdrawals = toNumber(r.amount);
  }

  const rows = Array.from(byBucket.values()).sort((a, b) => b.ggr - a.ggr);
  return { rows, groupBy };
}
