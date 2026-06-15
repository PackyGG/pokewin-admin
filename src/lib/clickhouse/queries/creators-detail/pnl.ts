import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — /creators/[userId] per-creator House P&L HEADLINE aggregates, read
 * from the ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getCreatorPnl` (src/lib/queries/
 * creators-pnl.ts) — the HEADLINE per-window + lifetime totals only:
 *
 *   pnl = deposits − cardWithdrawals      (wagered is shown for context, NOT in the formula)
 *
 * (House POV: positive = house kept value; negative = physical cards out
 * exceeded cash deposited under coverage.) The per-user popover ROWS (top-50
 * ranked list per window) are a per-row list, not scalar — OUT OF SCOPE for this
 * comparison snapshot, like the code-analytics twin's referrals list.
 *
 * ─── COVERAGE ATTRIBUTION (mirrored EXACTLY) ─────────────────────────
 *
 * A completed ledger deposit at time T by user U is attributed to this creator
 * iff the MOST RECENT `affiliate_code_usages` row for U with
 * `created_at <= T AND created_at >= T - 7 days` belongs to this creator
 * (code-of-record at deposit time; most-recent wins on code-switch). The PG
 * correlated subquery (`COVERING_CREATOR_SQL`) is replicated here with an
 * ASOF LEFT JOIN (`a.created_at <= d.created_at` picks the greatest acu time at
 * or before the deposit), then a 7-day-window + creator-id filter — byte-exact
 * to the PG semantics, including the code-switch / outside-window NULL cases.
 *
 * ─── SCOPE PER LEG (mirrored EXACTLY — the scopes are NOT uniform) ────
 *   • deposits headline (attr_dep) — covered deposits whose withdrawing user is
 *     a real customer: `role NOT IN ('admin','support','creator')`,
 *     `id != {creatorId}`, + blacklist. Per-window = the same 365d-capped scan
 *     bucketed (PG's per-period scan is 30d-bounded; every displayed window is
 *     ≤30d so the 365d-capped scan bucketed to ≤30d yields identical numbers,
 *     and lifetime = the full 365d sum).
 *   • wagered headline (creator_wager) — this creator's acu `usage_type='wager'`
 *     rows, SAME 3-role + id≠creator + blacklist scope.
 *   • cardWithdrawals headline (attr_wd) — withdrawn value-units (cards via
 *     `card_withdrawal_requests.inventory_item_ids` → user_inventory; session-
 *     linked vouchers via `voucher_ids` → vouchers) whose withdrawal is a HOUSE
 *     LIABILITY (status IN pending/processing/shipped/completed), the withdrawing
 *     user is a COVERAGE-DEPOSITOR of this creator (NO role/blacklist filter on
 *     that user — matches PG), and the unit's source session is one of this
 *     creator's wager sessions (3-role + id≠creator + blacklist on the wagering
 *     user). withdrawn_at = COALESCE(shipped_at, completed_at, processing_at,
 *     requested_at).
 *       PER-WINDOW: depositor + session membership sets are UNBOUNDED (only the
 *       withdrawal event is 30d-bounded then bucketed) — verbatim to PG's
 *       per-period cardWD query.
 *       LIFETIME: depositor + session sets + the withdrawal event are all
 *       365d-bounded — verbatim to PG's lifetime block.
 *
 * Window cutoffs are derived from a single caller-supplied `now` so a parity
 * harness can feed both engines a byte-identical cutoff (prod runs UTC).
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table
 * (incl. every JOIN / sub-select / ASOF side); money stays Decimal end-to-end
 * (`toString(sum(...))` in SQL → `toNumber()` in TS, never Float); ids are bound
 * `{name:Type}` params. The blacklist is passed IN by the caller so this module
 * imports NO Postgres/Prisma client — it is a pure ClickHouse read.
 */

const LIFETIME_LOOKBACK_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// WITHDRAWAL_LIABILITY_STATUSES (pnl.ts) — in-flight (pending/processing) +
// done (shipped/completed) count as a house liability.
const WD_LIABILITY_STATUSES = ["pending", "processing", "shipped", "completed"] as const;
const WD_LIABILITY_SQL = `(${WD_LIABILITY_STATUSES.map((s) => `'${s}'`).join(",")})`;

const PERIOD_KEYS = ["24h", "3d", "7d", "14d", "30d"] as const;
type PeriodKey = (typeof PERIOD_KEYS)[number];

export type CreatorPnlHeadlineSnapshot = {
  byPeriod: Record<
    PeriodKey,
    { deposits: number; wagered: number; cardWithdrawals: number; pnl: number }
  >;
  lifetime: {
    totalDeposits: number;
    totalWagered: number;
    totalCardWithdrawals: number;
    pnl: number;
  };
};

type DepositRow = {
  dep_24h: string;
  dep_3d: string;
  dep_7d: string;
  dep_14d: string;
  dep_30d: string;
  dep_lifetime: string;
};
type WagerRow = {
  w_24h: string;
  w_3d: string;
  w_7d: string;
  w_14d: string;
  w_30d: string;
  w_lifetime: string;
};
type PeriodCwdRow = {
  cwd_24h: string;
  cwd_3d: string;
  cwd_7d: string;
  cwd_14d: string;
  cwd_30d: string;
};
type LifetimeCwdRow = { cwd_lifetime: string };

export async function getCreatorPnlHeadlineFromClickHouse(
  userId: string,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CreatorPnlHeadlineSnapshot> {
  const hasBlacklist = blacklist.length > 0;
  const d1 = chDateTime(new Date(now.getTime() - 1 * DAY_MS));
  const d3 = chDateTime(new Date(now.getTime() - 3 * DAY_MS));
  const d7 = chDateTime(new Date(now.getTime() - 7 * DAY_MS));
  const d14 = chDateTime(new Date(now.getTime() - 14 * DAY_MS));
  const d30 = chDateTime(new Date(now.getTime() - 30 * DAY_MS));
  const lifetime = chDateTime(
    new Date(now.getTime() - LIFETIME_LOOKBACK_DAYS * DAY_MS),
  );

  const blacklistUFilter = hasBlacklist
    ? "AND u.id NOT IN {blacklist:Array(String)}"
    : "";

  const params: Record<string, unknown> = {
    userId,
    d1,
    d3,
    d7,
    d14,
    d30,
    lifetime,
  };
  if (hasBlacklist) params.blacklist = blacklist;

  // Users this creator has any acu row for — the only users whose deposits can
  // ever attribute to this creator. Pre-filtering the (otherwise full-history)
  // deposit scan to them is exact (a non-referred user can never have
  // coverage = this creator) and keeps the ASOF scan bounded.
  const referredUsersCte = `referred_users AS (
      SELECT DISTINCT referred_user_id AS uid
      FROM ${CH_DB}.public_affiliate_code_usages FINAL
      WHERE _peerdb_is_deleted = 0 AND affiliate_user_id = {userId:String}
    )`;

  // Full acu (every creator's rows) for this user — the ASOF "most recent code"
  // probe must see ALL codes so code-switching resolves to the latest one.
  const acuAllCte = `acu_all AS (
      SELECT referred_user_id AS ruid, affiliate_user_id AS auid, created_at AS acat
      FROM ${CH_DB}.public_affiliate_code_usages FINAL
      WHERE _peerdb_is_deleted = 0
    )`;

  // ── deposits headline (covered, 3-role + id≠creator + blacklist) ──────
  const depositsSql = `
    WITH
    ${referredUsersCte},
    ${acuAllCte},
    elig_deposits AS (
      SELECT lt.user_id AS uid, lt.created_at AS cat, lt.amount AS amt
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = lt.user_id AND u._peerdb_is_deleted = 0
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.created_at >= {lifetime:DateTime64(6)}
        AND lt.user_id IN (SELECT uid FROM referred_users)
        AND u.role NOT IN ('admin','support','creator')
        AND u.id != {userId:String}
        ${blacklistUFilter}
    ),
    covered AS (
      SELECT d.cat AS cat, d.amt AS amt, a.auid AS cov, a.acat AS acat
      FROM elig_deposits AS d
      ASOF LEFT JOIN acu_all AS a
        ON d.uid = a.ruid AND a.acat <= d.cat
    )
    SELECT
      toString(sumIf(amt, cat >= {d1:DateTime64(6)}))  AS dep_24h,
      toString(sumIf(amt, cat >= {d3:DateTime64(6)}))  AS dep_3d,
      toString(sumIf(amt, cat >= {d7:DateTime64(6)}))  AS dep_7d,
      toString(sumIf(amt, cat >= {d14:DateTime64(6)})) AS dep_14d,
      toString(sumIf(amt, cat >= {d30:DateTime64(6)})) AS dep_30d,
      toString(sum(amt))                               AS dep_lifetime
    FROM covered
    WHERE cov = {userId:String}
      AND acat >= cat - INTERVAL 7 DAY`;

  // ── wagered headline (this creator's acu wager rows, 3-role scope) ────
  const wageredSql = `
    WITH creator_wager AS (
      SELECT acu.created_at AS cat, acu.wager_amount_usd AS wa
      FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = acu.referred_user_id AND u._peerdb_is_deleted = 0
      WHERE acu._peerdb_is_deleted = 0
        AND acu.affiliate_user_id = {userId:String}
        AND acu.usage_type = 'wager'
        AND acu.created_at >= {lifetime:DateTime64(6)}
        AND u.role NOT IN ('admin','support','creator')
        AND u.id != {userId:String}
        ${blacklistUFilter}
    )
    SELECT
      toString(sumIf(wa, cat >= {d1:DateTime64(6)}))  AS w_24h,
      toString(sumIf(wa, cat >= {d3:DateTime64(6)}))  AS w_3d,
      toString(sumIf(wa, cat >= {d7:DateTime64(6)}))  AS w_7d,
      toString(sumIf(wa, cat >= {d14:DateTime64(6)})) AS w_14d,
      toString(sumIf(wa, cat >= {d30:DateTime64(6)})) AS w_30d,
      toString(sum(wa))                               AS w_lifetime
    FROM creator_wager`;

  // Withdrawn value-units (cards + session-linked vouchers) — emitted once,
  // reused by both the per-window and lifetime cardWD scans. withdrawn_at =
  // COALESCE(shipped, completed, processing, requested).
  const withdrawnUnitsCte = (alias: string) => `${alias} AS (
      SELECT cwr_c.withdrawn_at AS withdrawn_at, ui.user_id AS user_id,
             ui.source_id AS source_id, ui.value_at_obtained AS value
      FROM (
        SELECT
          coalesce(shipped_at, completed_at, processing_at, requested_at) AS withdrawn_at,
          arrayJoin(inventory_item_ids) AS item_id
        FROM ${CH_DB}.public_card_withdrawal_requests FINAL
        WHERE _peerdb_is_deleted = 0 AND status IN ${WD_LIABILITY_SQL}
      ) AS cwr_c
      INNER JOIN ${CH_DB}.public_user_inventory AS ui FINAL
        ON ui.id = cwr_c.item_id AND ui._peerdb_is_deleted = 0
      WHERE ui.source_type IN ('pack','battle')
      UNION ALL
      SELECT cwr_v.withdrawn_at AS withdrawn_at, v.user_id AS user_id,
             v.origin_id AS source_id, v.value AS value
      FROM (
        SELECT
          coalesce(shipped_at, completed_at, processing_at, requested_at) AS withdrawn_at,
          arrayJoin(voucher_ids) AS voucher_id
        FROM ${CH_DB}.public_card_withdrawal_requests FINAL
        WHERE _peerdb_is_deleted = 0 AND status IN ${WD_LIABILITY_SQL}
      ) AS cwr_v
      INNER JOIN ${CH_DB}.public_vouchers AS v FINAL
        ON v.id = cwr_v.voucher_id AND v._peerdb_is_deleted = 0
      WHERE v.origin IN ('battle_excess_to_voucher','pack_borrow_to_voucher')
    )`;

  // ── per-window cardWithdrawals headline (UNBOUNDED depositor + session sets;
  //    NO role/blacklist on the WITHDRAWING user — verbatim to PG) ──────
  const periodCwdSql = `
    WITH
    ${referredUsersCte},
    ${acuAllCte},
    wd_sessions AS (
      SELECT DISTINCT acu.game_session_id AS gsid
      FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = acu.referred_user_id AND u._peerdb_is_deleted = 0
      WHERE acu._peerdb_is_deleted = 0
        AND acu.affiliate_user_id = {userId:String}
        AND acu.usage_type = 'wager'
        AND acu.game_session_id IS NOT NULL
        AND u.role NOT IN ('admin','support','creator')
        AND u.id != {userId:String}
        ${blacklistUFilter}
    ),
    all_deposits AS (
      SELECT lt.user_id AS uid, lt.created_at AS cat
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.user_id IN (SELECT uid FROM referred_users)
    ),
    cov_deposits AS (
      SELECT d.uid AS uid, a.auid AS cov, a.acat AS acat, d.cat AS cat
      FROM all_deposits AS d
      ASOF LEFT JOIN acu_all AS a
        ON d.uid = a.ruid AND a.acat <= d.cat
    ),
    wd_depositors AS (
      SELECT DISTINCT uid
      FROM cov_deposits
      WHERE cov = {userId:String} AND acat >= cat - INTERVAL 7 DAY
    ),
    ${withdrawnUnitsCte("wu")}
    SELECT
      toString(sumIf(value, withdrawn_at >= {d1:DateTime64(6)}))  AS cwd_24h,
      toString(sumIf(value, withdrawn_at >= {d3:DateTime64(6)}))  AS cwd_3d,
      toString(sumIf(value, withdrawn_at >= {d7:DateTime64(6)}))  AS cwd_7d,
      toString(sumIf(value, withdrawn_at >= {d14:DateTime64(6)})) AS cwd_14d,
      toString(sumIf(value, withdrawn_at >= {d30:DateTime64(6)})) AS cwd_30d
    FROM wu
    WHERE withdrawn_at >= {d30:DateTime64(6)}
      AND user_id IN (SELECT uid FROM wd_depositors)
      AND source_id IN (SELECT gsid FROM wd_sessions)`;

  // ── lifetime cardWithdrawals headline (365d depositor + session sets) ──
  const lifetimeCwdSql = `
    WITH
    ${referredUsersCte},
    ${acuAllCte},
    creator_sessions AS (
      SELECT DISTINCT acu.game_session_id AS gsid
      FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = acu.referred_user_id AND u._peerdb_is_deleted = 0
      WHERE acu._peerdb_is_deleted = 0
        AND acu.affiliate_user_id = {userId:String}
        AND acu.usage_type = 'wager'
        AND acu.created_at >= {lifetime:DateTime64(6)}
        AND acu.game_session_id IS NOT NULL
        AND u.role NOT IN ('admin','support','creator')
        AND u.id != {userId:String}
        ${blacklistUFilter}
    ),
    all_deposits AS (
      SELECT lt.user_id AS uid, lt.created_at AS cat
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND lt.created_at >= {lifetime:DateTime64(6)}
        AND lt.user_id IN (SELECT uid FROM referred_users)
    ),
    cov_deposits AS (
      SELECT d.uid AS uid, a.auid AS cov, a.acat AS acat, d.cat AS cat
      FROM all_deposits AS d
      ASOF LEFT JOIN acu_all AS a
        ON d.uid = a.ruid AND a.acat <= d.cat
    ),
    cov_depositors_raw AS (
      SELECT DISTINCT uid
      FROM cov_deposits
      WHERE cov = {userId:String} AND acat >= cat - INTERVAL 7 DAY
    ),
    ${withdrawnUnitsCte("wu")}
    SELECT toString(sum(value)) AS cwd_lifetime
    FROM wu
    WHERE withdrawn_at >= {lifetime:DateTime64(6)}
      AND user_id IN (SELECT uid FROM cov_depositors_raw)
      AND source_id IN (SELECT gsid FROM creator_sessions)`;

  const [depRows, wagRows, periodCwdRows, lifetimeCwdRows] = await Promise.all([
    clickhouseRead.query<DepositRow>({
      queryName: "creators.detailPnl.deposits",
      sql: depositsSql,
      params,
    }),
    clickhouseRead.query<WagerRow>({
      queryName: "creators.detailPnl.wagered",
      sql: wageredSql,
      params,
    }),
    clickhouseRead.query<PeriodCwdRow>({
      queryName: "creators.detailPnl.periodCardWithdrawals",
      sql: periodCwdSql,
      params,
    }),
    clickhouseRead.query<LifetimeCwdRow>({
      queryName: "creators.detailPnl.lifetimeCardWithdrawals",
      sql: lifetimeCwdSql,
      params,
    }),
  ]);

  const dep = depRows[0];
  const wag = wagRows[0];
  const cwd = periodCwdRows[0];

  const depByPeriod: Record<PeriodKey, number> = {
    "24h": toNumber(dep?.dep_24h ?? "0"),
    "3d": toNumber(dep?.dep_3d ?? "0"),
    "7d": toNumber(dep?.dep_7d ?? "0"),
    "14d": toNumber(dep?.dep_14d ?? "0"),
    "30d": toNumber(dep?.dep_30d ?? "0"),
  };
  const wagByPeriod: Record<PeriodKey, number> = {
    "24h": toNumber(wag?.w_24h ?? "0"),
    "3d": toNumber(wag?.w_3d ?? "0"),
    "7d": toNumber(wag?.w_7d ?? "0"),
    "14d": toNumber(wag?.w_14d ?? "0"),
    "30d": toNumber(wag?.w_30d ?? "0"),
  };
  const cwdByPeriod: Record<PeriodKey, number> = {
    "24h": toNumber(cwd?.cwd_24h ?? "0"),
    "3d": toNumber(cwd?.cwd_3d ?? "0"),
    "7d": toNumber(cwd?.cwd_7d ?? "0"),
    "14d": toNumber(cwd?.cwd_14d ?? "0"),
    "30d": toNumber(cwd?.cwd_30d ?? "0"),
  };

  const byPeriod = {} as CreatorPnlHeadlineSnapshot["byPeriod"];
  for (const key of PERIOD_KEYS) {
    const deposits = depByPeriod[key];
    const cardWithdrawals = cwdByPeriod[key];
    byPeriod[key] = {
      deposits,
      wagered: wagByPeriod[key],
      cardWithdrawals,
      pnl: deposits - cardWithdrawals,
    };
  }

  const totalDeposits = toNumber(dep?.dep_lifetime ?? "0");
  const totalWagered = toNumber(wag?.w_lifetime ?? "0");
  const totalCardWithdrawals = toNumber(lifetimeCwdRows[0]?.cwd_lifetime ?? "0");

  return {
    byPeriod,
    lifetime: {
      totalDeposits,
      totalWagered,
      totalCardWithdrawals,
      pnl: totalDeposits - totalCardWithdrawals,
    },
  };
}
