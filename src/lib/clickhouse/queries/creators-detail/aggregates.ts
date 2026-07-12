import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — /creators/[userId] detail-page aggregate snapshot, read from the
 * ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getCreatorDetail`
 * (src/lib/queries/creators-detail.ts). Returns the SETTLED scalar aggregate
 * fields the detail page renders (KPI strip + acquisition funnel + affiliate
 * payouts), so comparison mode can diff the two engines field-for-field.
 *
 * SCOPE — mirrors the PG twin EXACTLY, PER LEG (the scopes are NOT uniform):
 *   • signups (referred-user counts) — `public_user.referred_by = {creatorId}`,
 *     365-day lifetime cap, NO role scope / NO blacklist (PG counts every
 *     referred signup, only bounded by the 365d cap).
 *   • clicks — `public_affiliate_clicks.code IN (this creator's codes,
 *     uppercased)`, 365-day cap, NO user scope (clicks are by code).
 *   • realAffiliateAgg (wager volume / commission / FTD / active / per-game
 *     wager breakdown) — `affiliate_code_usages.affiliate_user_id = {creatorId}`
 *     JOIN user, `role NOT IN ('admin','support','creator')` + blacklist, 365d
 *     cap. This is the canonical 3-role customer scope (creators DROPPED), the
 *     SAME scope `getCreatorPnl`/momentum use.
 *   • ftdByPeriod — distinct depositors (acu `usage_type='deposit'` JOIN a
 *     balances row with `total_deposited > 0`), 365d cap, NO role scope / NO
 *     blacklist (matches the PG ftdStats query exactly).
 *   • account (available / paid-out / bonus-distributed) — single
 *     `affiliate_accounts` row for this creator (point lookup; 0 when absent).
 *   • pending — count of `affiliate_code_queue` rows for the PRIMARY code (the
 *     oldest `affiliate_codes` row), 0 when the creator has no codes.
 *
 * The countryBreakdown FULL OUTER JOIN list (top-30 by clicks+signups) is a
 * per-row list, not a scalar — OUT OF SCOPE for this comparison snapshot, like
 * the code-analytics twin's country breakdown + referrals list.
 *
 * Window cutoffs are derived from a single caller-supplied `now` (mirroring the
 * PG path's JS-computed `oneDayAgo`/…/`lifetimeCutoff` and the SQL
 * `NOW() - INTERVAL` buckets) so a parity harness can feed both engines a
 * byte-identical cutoff. Prod runs UTC, so an N-day interval is exactly N*24h.
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors): FINAL +
 * `_peerdb_is_deleted = 0` on every mirror table (incl. every JOIN/sub-select);
 * money stays Decimal end-to-end (`toString(sum(...))` in SQL → `toNumber()` in
 * TS, never Float). Code ids + the creator id are bound `{name:Type}` params —
 * never string-concatenated. The blacklist is passed IN by the caller so this
 * module imports NO Postgres/Prisma client — it is a pure ClickHouse read.
 */

const CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

type CreatorDetailAggregatesSnapshot = {
  clicksTotal: number;
  clicks24h: number;
  clicks7d: number;
  clicks14d: number;
  clicks30d: number;
  signupsTotal: number;
  signups24h: number;
  signups7d: number;
  signups14d: number;
  signups30d: number;
  signupsPending: number;
  totalWagerVolumeUsd: number;
  wagerPacks: number;
  wagerBattles: number;
  wagerUpgrader: number;
  totalEarnedUsd: number;
  ftdCount: number;
  activeReferrals7d: number;
  activeReferrals24h: number;
  availableUsd: number;
  totalPaidOutUsd: number;
  totalBonusDistributedUsd: number;
  ftd1d: number;
  ftd3d: number;
  ftd7d: number;
  ftd14d: number;
  ftd30d: number;
  ftdAll: number;
};

type CodeRow = { code: string };
type CountBucketRow = {
  total: string;
  last_24h: string;
  last_7d: string;
  last_14d: string;
  last_30d: string;
};
type AffiliateAggRow = {
  wager_volume: string;
  commission: string;
  ftd_count: string;
  active_7d: string;
  active_24h: string;
  pack_wager: string;
  battle_wager: string;
  upgrader_wager: string;
};
type FtdRow = {
  p_1d: string;
  p_3d: string;
  p_7d: string;
  p_14d: string;
  p_30d: string;
  p_all: string;
};
type AccountRow = {
  available_usd: string;
  total_paid_out_usd: string;
  total_bonus_distributed_usd: string;
};
type PendingRow = { pending: string };

export async function getCreatorDetailAggregatesFromClickHouse(
  userId: string,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CreatorDetailAggregatesSnapshot> {
  const hasBlacklist = blacklist.length > 0;
  const d1 = chDateTime(new Date(now.getTime() - 1 * DAY_MS));
  const d3 = chDateTime(new Date(now.getTime() - 3 * DAY_MS));
  const d7 = chDateTime(new Date(now.getTime() - 7 * DAY_MS));
  const d14 = chDateTime(new Date(now.getTime() - 14 * DAY_MS));
  const d30 = chDateTime(new Date(now.getTime() - 30 * DAY_MS));
  const lifetime = chDateTime(
    new Date(now.getTime() - CREATOR_DETAIL_LIFETIME_LOOKBACK_DAYS * DAY_MS),
  );

  // The creator's own codes (oldest first). primaryCode = first row (as-is
  // casing, matches PG `allCodes[0].code`); clickCodes = distinct UPPERCASED
  // set (PG uppercases every code for the clicks scan).
  const codeRows = await clickhouseRead.query<CodeRow>({
    queryName: "creators.detailAggregates.codes",
    sql: `
      SELECT code
      FROM ${CH_DB}.public_affiliate_codes FINAL
      WHERE _peerdb_is_deleted = 0
        AND user_id = {userId:String}
      ORDER BY created_at ASC`,
    params: { userId },
  });
  const primaryCode = codeRows[0]?.code ?? "";
  const clickCodes = Array.from(
    new Set(codeRows.map((c) => c.code.toUpperCase()).filter((c) => !!c)),
  );

  const blacklistFilter = hasBlacklist
    ? "AND u.id NOT IN {blacklist:Array(String)}"
    : "";

  // signupCounts — referred-user counts, 365d cap, NO role scope / blacklist.
  const signupsSql = `
    SELECT
      toString(count())                          AS total,
      toString(countIf(created_at >= {d1:DateTime64(6)}))  AS last_24h,
      toString(countIf(created_at >= {d7:DateTime64(6)}))  AS last_7d,
      toString(countIf(created_at >= {d14:DateTime64(6)})) AS last_14d,
      toString(countIf(created_at >= {d30:DateTime64(6)})) AS last_30d
    FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND referred_by = {userId:String}
      AND created_at >= {lifetime:DateTime64(6)}`;

  // clickCounts — by code set, 365d cap, NO user scope. Empty code set → 0.
  const clicksSql = `
    SELECT
      toString(count())                          AS total,
      toString(countIf(created_at >= {d1:DateTime64(6)}))  AS last_24h,
      toString(countIf(created_at >= {d7:DateTime64(6)}))  AS last_7d,
      toString(countIf(created_at >= {d14:DateTime64(6)})) AS last_14d,
      toString(countIf(created_at >= {d30:DateTime64(6)})) AS last_30d
    FROM ${CH_DB}.public_affiliate_clicks FINAL
    WHERE _peerdb_is_deleted = 0
      AND code IN {clickCodes:Array(String)}
      AND created_at >= {lifetime:DateTime64(6)}`;

  // realAffiliateAgg — wager/commission/FTD/active + per-game wager breakdown.
  // 3-role scope (creators DROPPED) + blacklist, 365d cap. The per-game sums
  // come from a LEFT JOIN to game_sessions on the acu wager session id (deposit
  // rows carry a NULL session → NULL game_type → contribute 0, exactly as the
  // PG LEFT JOIN + CASE ELSE 0 does).
  const affiliateAggSql = `
    WITH acu_scoped AS (
      SELECT
        acu.referred_user_id AS ruid,
        acu.usage_type       AS ut,
        acu.created_at       AS cat,
        acu.wager_amount_usd AS wa,
        acu.referrer_cut_usd AS rc,
        acu.game_session_id  AS gsid
      FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = acu.referred_user_id AND u._peerdb_is_deleted = 0
      WHERE acu._peerdb_is_deleted = 0
        AND acu.affiliate_user_id = {userId:String}
        AND u.role NOT IN ('admin','support','creator')
        ${blacklistFilter}
        AND acu.created_at >= {lifetime:DateTime64(6)}
    ),
    depositors AS (
      SELECT user_id
      FROM ${CH_DB}.public_balances FINAL
      WHERE _peerdb_is_deleted = 0 AND total_deposited > 0
    )
    SELECT
      toString(sum(s.wa)) AS wager_volume,
      toString(sum(s.rc)) AS commission,
      toString(uniqExactIf(s.ruid, s.ut = 'deposit' AND s.ruid IN (SELECT user_id FROM depositors))) AS ftd_count,
      toString(uniqExactIf(s.ruid, s.ut IN ('deposit','wager') AND s.cat >= {d7:DateTime64(6)})) AS active_7d,
      toString(uniqExactIf(s.ruid, s.ut IN ('deposit','wager') AND s.cat >= {d1:DateTime64(6)})) AS active_24h,
      toString(sumIf(s.wa, gs.gt = 'pack'))     AS pack_wager,
      toString(sumIf(s.wa, gs.gt = 'battle'))   AS battle_wager,
      toString(sumIf(s.wa, gs.gt = 'upgrader')) AS upgrader_wager
    FROM acu_scoped AS s
    LEFT JOIN (
      SELECT id, game_type AS gt
      FROM ${CH_DB}.public_game_sessions FINAL
      WHERE _peerdb_is_deleted = 0
    ) AS gs ON gs.id = s.gsid`;

  // ftdByPeriod — distinct depositors per window, JOIN a balances row with
  // total_deposited > 0, 365d cap, NO role scope / blacklist.
  const ftdSql = `
    WITH dep_usages AS (
      SELECT acu.referred_user_id AS ruid, acu.created_at AS cat
      FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
      WHERE acu._peerdb_is_deleted = 0
        AND acu.affiliate_user_id = {userId:String}
        AND acu.usage_type = 'deposit'
        AND acu.created_at >= {lifetime:DateTime64(6)}
        AND acu.referred_user_id IN (
          SELECT user_id FROM ${CH_DB}.public_balances FINAL
          WHERE _peerdb_is_deleted = 0 AND total_deposited > 0
        )
    )
    SELECT
      toString(uniqExactIf(ruid, cat >= {d1:DateTime64(6)}))  AS p_1d,
      toString(uniqExactIf(ruid, cat >= {d3:DateTime64(6)}))  AS p_3d,
      toString(uniqExactIf(ruid, cat >= {d7:DateTime64(6)}))  AS p_7d,
      toString(uniqExactIf(ruid, cat >= {d14:DateTime64(6)})) AS p_14d,
      toString(uniqExactIf(ruid, cat >= {d30:DateTime64(6)})) AS p_30d,
      toString(uniqExact(ruid))                               AS p_all
    FROM dep_usages`;

  // account — single affiliate_accounts row (point lookup; 0 when absent).
  const accountSql = `
    SELECT
      toString(sum(available_usd))                 AS available_usd,
      toString(sum(total_paid_out_usd))            AS total_paid_out_usd,
      toString(sum(total_bonus_distributed_usd))   AS total_bonus_distributed_usd
    FROM ${CH_DB}.public_affiliate_accounts FINAL
    WHERE _peerdb_is_deleted = 0
      AND user_id = {userId:String}`;

  const baseParams: Record<string, unknown> = {
    userId,
    d1,
    d3,
    d7,
    d14,
    d30,
    lifetime,
    clickCodes,
  };
  if (hasBlacklist) baseParams.blacklist = blacklist;

  const [signupRows, clickRows, affRows, ftdRows, accountRows] =
    await Promise.all([
      clickhouseRead.query<CountBucketRow>({
        queryName: "creators.detailAggregates.signups",
        sql: signupsSql,
        params: baseParams,
      }),
      clickhouseRead.query<CountBucketRow>({
        queryName: "creators.detailAggregates.clicks",
        sql: clicksSql,
        params: baseParams,
      }),
      clickhouseRead.query<AffiliateAggRow>({
        queryName: "creators.detailAggregates.affiliateAgg",
        sql: affiliateAggSql,
        params: baseParams,
      }),
      clickhouseRead.query<FtdRow>({
        queryName: "creators.detailAggregates.ftdByPeriod",
        sql: ftdSql,
        params: baseParams,
      }),
      clickhouseRead.query<AccountRow>({
        queryName: "creators.detailAggregates.account",
        sql: accountSql,
        params: baseParams,
      }),
    ]);

  // pending — only when the creator has a primary code (PG gates on it).
  let pending = 0;
  if (primaryCode) {
    const pendingRows = await clickhouseRead.query<PendingRow>({
      queryName: "creators.detailAggregates.pending",
      sql: `
        SELECT toString(count()) AS pending
        FROM ${CH_DB}.public_affiliate_code_queue FINAL
        WHERE _peerdb_is_deleted = 0
          AND code = {primaryCode:String}`,
      params: { primaryCode },
    });
    pending = Number(pendingRows[0]?.pending ?? 0);
  }

  const s = signupRows[0];
  const c = clickRows[0];
  const a = affRows[0];
  const f = ftdRows[0];
  const acc = accountRows[0];

  return {
    clicksTotal: Number(c?.total ?? 0),
    clicks24h: Number(c?.last_24h ?? 0),
    clicks7d: Number(c?.last_7d ?? 0),
    clicks14d: Number(c?.last_14d ?? 0),
    clicks30d: Number(c?.last_30d ?? 0),
    signupsTotal: Number(s?.total ?? 0),
    signups24h: Number(s?.last_24h ?? 0),
    signups7d: Number(s?.last_7d ?? 0),
    signups14d: Number(s?.last_14d ?? 0),
    signups30d: Number(s?.last_30d ?? 0),
    signupsPending: pending,
    totalWagerVolumeUsd: toNumber(a?.wager_volume ?? "0"),
    wagerPacks: toNumber(a?.pack_wager ?? "0"),
    wagerBattles: toNumber(a?.battle_wager ?? "0"),
    wagerUpgrader: toNumber(a?.upgrader_wager ?? "0"),
    totalEarnedUsd: toNumber(a?.commission ?? "0"),
    ftdCount: Number(a?.ftd_count ?? 0),
    activeReferrals7d: Number(a?.active_7d ?? 0),
    activeReferrals24h: Number(a?.active_24h ?? 0),
    availableUsd: toNumber(acc?.available_usd ?? "0"),
    totalPaidOutUsd: toNumber(acc?.total_paid_out_usd ?? "0"),
    totalBonusDistributedUsd: toNumber(acc?.total_bonus_distributed_usd ?? "0"),
    ftd1d: Number(f?.p_1d ?? 0),
    ftd3d: Number(f?.p_3d ?? 0),
    ftd7d: Number(f?.p_7d ?? 0),
    ftd14d: Number(f?.p_14d ?? 0),
    ftd30d: Number(f?.p_30d ?? 0),
    ftdAll: Number(f?.p_all ?? 0),
  };
}
