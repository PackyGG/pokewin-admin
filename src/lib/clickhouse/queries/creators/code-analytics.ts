import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, toNumber } from "../_shared";

/**
 * Phase 2B — Creator code-analytics KPI snapshot, read from the ClickHouse prod
 * game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getCodeAnalytics` (src/lib/queries/
 * creators-codes.ts). Returns the SAME settled scalar KPI fields so comparison
 * mode can diff the two engines field-for-field.
 *
 * SCOPE — mirrors the PG twin EXACTLY: `getCodeAnalytics` applies NO customer
 * scope (no `role NOT IN (...)`, no excluded-users blacklist). It is a per-code
 * aggregate over EVERY user who touched the code (the creator's referred
 * population — creators/staff are NOT filtered out). The CH twin therefore
 * deliberately omits both the wholesale `customerScopeCte` and the blacklist;
 * applying either would make comparison drift signal an intended scope
 * difference rather than a real engine/CDC bug. (The slim sibling queries
 * `getCodeReferrals` / `getRecentWagersOnCode` DO apply a 2-role + blacklist
 * filter, but those are SEPARATE functions and not part of `getCodeAnalytics`.)
 *
 * Code-casing handling mirrors the PG twin:
 *   • affiliate_codes / affiliate_code_usages: MIXED casing in storage → match
 *     case-insensitively with `upper(code) = {code:String}` (the bound param is
 *     pre-uppercased by the caller).
 *   • ledger_transactions.metadata.affiliate_code: matched
 *     `upper(JSONExtractString(metadata,'affiliate_code')) = {code:String}`.
 *   • affiliate_clicks.code: ALWAYS stored UPPERCASE → exact `code = {code:String}`.
 *
 * Fields covered (the settled lifetime KPIs the PG twin returns):
 *   • totalReferrals        = COUNT signup usages
 *   • activeReferrals       = COUNT(DISTINCT user) of deposit/wager usages
 *   • totalDeposits         = Σ affiliate_code_usages.deposit_amount_usd (FTD leg)
 *   • totalWagers           = Σ affiliate_code_usages.wager_amount_usd
 *   • totalCommission       = Σ affiliate_code_usages.referrer_cut_usd
 *   • codeDepositTotal      = Σ ledger deposit_bonus metadata.deposit_usd
 *   • codeDepositEventCount = COUNT of those deposit_bonus events
 *   • codeUniqueDepositors  = COUNT(DISTINCT user) of those events
 *   • totalClicks           = COUNT affiliate_clicks
 *
 * The windowed acquisition series (last 24h hourly / last 7d daily), the
 * lifetime per-day series, the country breakdown, and the top-50 referrals list
 * the PG twin also returns are OUT OF SCOPE for this comparison snapshot: the
 * acquisition series are inherently CDC-lag-sensitive (newest buckets), and the
 * per-row lists are not scalar-diffable. Comparison validates the SETTLED
 * scalar aggregates, exactly like the realized-pnl snapshot twin.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • FINAL + `_peerdb_is_deleted = 0` on every mirror table (incl. the JOIN).
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, toNumber() in
 *     TS — never Float / toFloat — so parity is exact to the cent. The jsonb
 *     `metadata.deposit_usd` is extracted as a typed Decimal
 *     (`JSONExtract(metadata,'deposit_usd','Decimal128(2)')`), matching the PG
 *     `(metadata->>'deposit_usd')::numeric` (verified 0 rows carry >2 decimals).
 *   • The code id is a bound `{code:String}` param — never string-concatenated.
 *
 * This module imports NO Postgres/Prisma client (directly or transitively) — it
 * is a pure ClickHouse read.
 */

type CodeAnalyticsSnapshot = {
  code: string;
  ownerUserId: string;
  ownerUsername: string | null;
  isActive: boolean;
  totalReferrals: number;
  activeReferrals: number;
  totalDeposits: number;
  codeDepositTotal: number;
  codeDepositEventCount: number;
  codeUniqueDepositors: number;
  totalWagers: number;
  totalCommission: number;
  totalClicks: number;
};

type CodeRow = { code: string; user_id: string; username: string | null };
type UsageRow = {
  total_signups: string;
  active_referrals: string;
  total_deposits: string;
  total_wagers: string;
  total_commission: string;
};
type DepositRow = {
  total: string;
  deposit_event_count: string;
  unique_depositors: string;
};
type ClickRow = { clicks: string };

/**
 * ClickHouse twin of `getCodeAnalytics` (settled scalar KPIs). Returns null when
 * no affiliate_codes row matches (mirrors the PG twin's `if (!codeRecord) return
 * null`). The `code` arg is uppercased before binding so it matches the PG
 * `UPPER(...)` predicates and the always-uppercase affiliate_clicks.code.
 */
export async function getCodeAnalyticsFromClickHouse(
  code: string,
): Promise<CodeAnalyticsSnapshot | null> {
  const upperCode = code.toUpperCase();
  const params = { code: upperCode };

  // Code record — INNER JOIN to public_user (mirrors the PG `JOIN "user"`), so a
  // code whose owner row is absent/soft-deleted yields no record (→ null).
  const codeSql = `
    SELECT ac.code AS code, ac.user_id AS user_id, u.username AS username
    FROM ${CH_DB}.public_affiliate_codes AS ac FINAL
    INNER JOIN ${CH_DB}.public_user AS u FINAL
      ON u.id = ac.user_id AND u._peerdb_is_deleted = 0
    WHERE ac._peerdb_is_deleted = 0
      AND upper(ac.code) = {code:String}
    LIMIT 1`;

  // Usage aggregate (affiliate_code_usages) — signups, distinct active users,
  // FTD deposit / wager / commission money sums. Money summed as Decimal.
  const usageSql = `
    SELECT
      toString(countIf(usage_type = 'signup')) AS total_signups,
      toString(uniqExactIf(referred_user_id, usage_type IN ('deposit','wager'))) AS active_referrals,
      toString(sum(deposit_amount_usd)) AS total_deposits,
      toString(sum(wager_amount_usd))   AS total_wagers,
      toString(sum(referrer_cut_usd))   AS total_commission
    FROM ${CH_DB}.public_affiliate_code_usages FINAL
    WHERE _peerdb_is_deleted = 0
      AND upper(code) = {code:String}`;

  // Real total deposit volume + counts from ledger deposit_bonus events whose
  // metadata pins the deposit to this affiliate_code. deposit_usd extracted as a
  // typed Decimal so the sum stays cent-exact (matches PG `::numeric`).
  const depositSql = `
    SELECT
      toString(sum(JSONExtract(metadata, 'deposit_usd', 'Decimal128(2)'))) AS total,
      toString(count())                AS deposit_event_count,
      toString(uniqExact(user_id))     AS unique_depositors
    FROM ${CH_DB}.public_ledger_transactions FINAL
    WHERE _peerdb_is_deleted = 0
      AND type = 'deposit_bonus'
      AND upper(JSONExtractString(metadata, 'affiliate_code')) = {code:String}`;

  // Total clicks on this code. affiliate_clicks.code is always stored UPPERCASE
  // (trackClick uppercases before insert), so an exact match mirrors the PG
  // `count({ where: { code: uppercaseCode } })`.
  const clickSql = `
    SELECT toString(count()) AS clicks
    FROM ${CH_DB}.public_affiliate_clicks FINAL
    WHERE _peerdb_is_deleted = 0
      AND code = {code:String}`;

  const codeRows = await clickhouseRead.query<CodeRow>({
    queryName: "creators.codeAnalytics.code",
    sql: codeSql,
    params,
  });
  const codeRecord = codeRows[0];
  if (!codeRecord) return null;

  const [usageRows, depositRows, clickRows] = await Promise.all([
    clickhouseRead.query<UsageRow>({
      queryName: "creators.codeAnalytics.usage",
      sql: usageSql,
      params,
    }),
    clickhouseRead.query<DepositRow>({
      queryName: "creators.codeAnalytics.deposits",
      sql: depositSql,
      params,
    }),
    clickhouseRead.query<ClickRow>({
      queryName: "creators.codeAnalytics.clicks",
      sql: clickSql,
      params,
    }),
  ]);

  const u = usageRows[0];
  const d = depositRows[0];
  const c = clickRows[0];

  return {
    code: codeRecord.code,
    ownerUserId: codeRecord.user_id,
    ownerUsername: codeRecord.username ?? null,
    isActive: true,
    totalReferrals: Number(u?.total_signups ?? 0),
    activeReferrals: Number(u?.active_referrals ?? 0),
    totalDeposits: toNumber(u?.total_deposits ?? "0"),
    codeDepositTotal: toNumber(d?.total ?? "0"),
    codeDepositEventCount: Number(d?.deposit_event_count ?? 0),
    codeUniqueDepositors: Number(d?.unique_depositors ?? 0),
    totalWagers: toNumber(u?.total_wagers ?? "0"),
    totalCommission: toNumber(u?.total_commission ?? "0"),
    totalClicks: Number(c?.clicks ?? 0),
  };
}
