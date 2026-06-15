import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  ForfeitedLapsedRow,
  RakebackExpiryData,
  RakebackExpiryWindow,
  RakebackForfeited,
} from "@/lib/queries/insights-rewards/expiry";

import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of the reward-expiry insights surface — RAKEBACK-SCOPED MVP.
 *
 * PARITY with the canonical Postgres definition
 * (`src/lib/queries/insights-rewards/expiry.ts`):
 *
 *   • windows — live claim window per rakeback type, straight from
 *     `rakeback_config` (type / display_name / expiration_days / enabled),
 *     ordered daily → weekly → monthly, filtered to those three types.
 *   • forfeited — behavioural "forfeited by lapsing" proxy: users who claimed
 *     rakeback in the PRIOR-equal window `[now-2d, now-d)` (SUM rakeback > 0)
 *     and did NOT claim in the CURRENT window `[now-d, now]`. Their prior-window
 *     rakeback is the value walked away from. `byType` splits the prior-window
 *     rakeback of the lapsed cohort by type; `sampleUsers` is the top 25 by
 *     prior rakeback. Lifetime (`all`) has no prior frame → `forfeited = null`.
 *
 * SCOPE (mirrors the PG twin EXACTLY — NOT the wholesale customer scope):
 *   role NOT IN ('admin','support')   (creators are KEPT, matching the rest of
 *   the rakeback surface) + the dynamic `excluded_users` blacklist. This is the
 *   admin/support-only scope (`realCustomerIdsSubquery`), NOT `customerScopeCte`
 *   (which would also drop creators) — using that here would be a scope change.
 *
 * The window boundaries reuse the SAME canonical `daysForInsightsPeriod` helper
 * the Postgres path uses, applied to a single caller-supplied `now`, so the
 * `[now-2d, now-d, now]` frame is identical to the PG `NOW() - INTERVAL`
 * arithmetic (prod runs UTC, so an N-day interval is exactly N*24h).
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors): dedup latest
 * row per id with FINAL, drop soft-deleted rows with `_peerdb_is_deleted = 0`,
 * money stays Decimal end-to-end (`toString(sum(...))` in SQL → `toNumber()` in
 * TS, never Float). The blacklist is passed IN by the caller so this module
 * never imports a Postgres/Prisma client — it is a pure ClickHouse read.
 */

const TYPE_ORDER = "multiIf(type = 'daily', 1, type = 'weekly', 2, type = 'monthly', 3, 4)";

type ConfigRow = {
  type: string;
  display_name: string;
  expiration_days: number | null;
  enabled: boolean;
};

function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/**
 * The lapsed-cohort CTE chain, shared by the totals / byType / sample queries so
 * all three resolve the SAME population in one place.
 */
function lapsedCtes(hasBlacklist: boolean): string {
  return `
    ${realUsersCte(hasBlacklist)},
    current_users AS (
      SELECT DISTINCT rc.user_id
      FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.claimed_at IS NOT NULL
        AND rc.user_id IN (SELECT id FROM real_users)
        AND rc.claimed_at >= {cutoffCurrent:DateTime64(6)}
    ),
    prior_claims AS (
      SELECT rc.user_id, rc.rakeback_type, rc.rakeback_amount_usd, rc.claimed_at
      FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
      WHERE rc._peerdb_is_deleted = 0
        AND rc.claimed_at IS NOT NULL
        AND rc.user_id IN (SELECT id FROM real_users)
        AND rc.claimed_at >= {cutoffPriorStart:DateTime64(6)}
        AND rc.claimed_at <  {cutoffCurrent:DateTime64(6)}
    ),
    prior_lapsed AS (
      SELECT
        user_id,
        sum(rakeback_amount_usd) AS prior_rakeback,
        count()                  AS prior_claims,
        max(claimed_at)          AS last_claimed_at
      FROM prior_claims
      GROUP BY user_id
      HAVING sum(rakeback_amount_usd) > 0
    ),
    lapsed AS (
      SELECT *
      FROM prior_lapsed
      WHERE user_id NOT IN (SELECT user_id FROM current_users)
    )`;
}

async function fetchWindows(): Promise<{
  windows: RakebackExpiryWindow[];
  expirationConfigured: boolean;
}> {
  const rows = await clickhouseRead.query<ConfigRow>({
    queryName: "insights.rewards.expiry.windows",
    sql: `
      SELECT
        type,
        display_name,
        expiration_days,
        enabled
      FROM ${CH_DB}.public_rakeback_config FINAL
      WHERE _peerdb_is_deleted = 0
      ORDER BY ${TYPE_ORDER}`,
  });

  const windows: RakebackExpiryWindow[] = rows
    .filter(
      (r): r is ConfigRow & { type: "daily" | "weekly" | "monthly" } =>
        r.type === "daily" || r.type === "weekly" || r.type === "monthly",
    )
    .map((r) => ({
      type: r.type,
      displayName: r.display_name,
      expirationDays:
        r.expiration_days != null ? Number(r.expiration_days) : null,
      enabled: r.enabled,
    }));

  // The mirror reflects the live PG schema; the column is present here, so the
  // PG `information_schema` probe is `true` too.
  return { windows, expirationConfigured: rows.length > 0 };
}

async function computeForfeited(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date,
): Promise<RakebackForfeited | null> {
  const days = daysForInsightsPeriod(period);
  if (days === null) return null;

  const hasBlacklist = blacklist.length > 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const cutoffCurrent = chDateTime(new Date(now.getTime() - days * dayMs));
  const cutoffPriorStart = chDateTime(
    new Date(now.getTime() - days * 2 * dayMs),
  );
  const params: Record<string, unknown> = {
    cutoffCurrent,
    cutoffPriorStart,
    blacklist,
  };
  const ctes = lapsedCtes(hasBlacklist);

  const [totalsRows, byTypeRows, sampleRows] = await Promise.all([
    clickhouseRead.query<{ lapsed_users: string; forfeited_value: string }>({
      queryName: "insights.rewards.expiry.forfeited.totals",
      sql: `
        WITH ${ctes}
        SELECT
          toString(count())            AS lapsed_users,
          toString(sum(prior_rakeback)) AS forfeited_value
        FROM lapsed`,
      params,
    }),
    clickhouseRead.query<{
      rakeback_type: string;
      forfeited: string;
      claims: string;
    }>({
      queryName: "insights.rewards.expiry.forfeited.by_type",
      sql: `
        WITH ${ctes}
        SELECT
          pc.rakeback_type                  AS rakeback_type,
          toString(sum(pc.rakeback_amount_usd)) AS forfeited,
          toString(count())                 AS claims
        FROM prior_claims AS pc
        WHERE pc.user_id IN (SELECT user_id FROM lapsed)
        GROUP BY pc.rakeback_type`,
      params,
    }),
    clickhouseRead.query<{
      user_id: string;
      username: string | null;
      prior_rakeback: string;
      prior_claims: string;
      last_claimed_at: string | null;
    }>({
      queryName: "insights.rewards.expiry.forfeited.sample",
      sql: `
        WITH ${ctes}
        SELECT
          l.user_id                  AS user_id,
          u.username                 AS username,
          toString(l.prior_rakeback) AS prior_rakeback,
          toString(l.prior_claims)   AS prior_claims,
          l.last_claimed_at          AS last_claimed_at
        FROM lapsed AS l
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = l.user_id
        WHERE u._peerdb_is_deleted = 0
        ORDER BY l.prior_rakeback DESC
        LIMIT 25`,
      params,
    }),
  ]);

  const totals = totalsRows[0] ?? { lapsed_users: "0", forfeited_value: "0" };

  const byType: RakebackForfeited["byType"] = byTypeRows
    .filter(
      (
        r,
      ): r is typeof r & { rakeback_type: "daily" | "weekly" | "monthly" } =>
        r.rakeback_type === "daily" ||
        r.rakeback_type === "weekly" ||
        r.rakeback_type === "monthly",
    )
    .map((r) => ({
      type: r.rakeback_type,
      forfeitedValue: toNumber(r.forfeited),
      lapsedClaims: Number(r.claims),
    }))
    .sort((a, b) => b.forfeitedValue - a.forfeitedValue);

  const sampleUsers: ForfeitedLapsedRow[] = sampleRows.map((r) => {
    const last =
      r.last_claimed_at == null || r.last_claimed_at === ""
        ? null
        : new Date(`${r.last_claimed_at.replace(" ", "T")}Z`).toISOString();
    return {
      userId: r.user_id,
      username: r.username,
      priorRakeback: toNumber(r.prior_rakeback),
      priorClaims: Number(r.prior_claims),
      lastClaimedAt: last,
    };
  });

  return {
    totalLapsedUsers: Number(totals.lapsed_users),
    totalForfeitedValue: toNumber(totals.forfeited_value),
    sampleUsers,
    byType,
  };
}

export async function getRakebackExpiryFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackExpiryData> {
  const [{ windows, expirationConfigured }, forfeited] = await Promise.all([
    fetchWindows(),
    computeForfeited(period, blacklist, now),
  ]);
  return { windows, expirationConfigured, forfeited };
}
