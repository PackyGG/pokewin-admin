import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB } from "@/lib/clickhouse/queries/_shared";

/**
 * ClickHouse twin of the heavy lifetime-coverage SQL behind
 * `getAllCreatorsLifetimePnl`
 * (src/app/(admin)/creators/_queries/all-creators-lifetime-pnl.ts).
 *
 * Returns the SAME per-creator row shape the Postgres `cachedLifetimePnlRows`
 * produces (one row per `role='creator'` present in any aggregate), so the
 * existing tab-filter + sort + aggregate in `getAllCreatorsLifetimePnl` runs
 * unchanged on either source via
 * `resolveAdminRead('creators_lifetime_pnl', { pg, ch })`.
 *
 * pnl is computed downstream as `total_deposits − total_card_withdrawals`
 * (total_wagered is returned for display only, NOT in the formula).
 *
 * ─── Attribution mirrored EXACTLY from the BATCH Postgres query ──────────
 *
 * Unlike the per-creator detail twin (creators-detail/pnl.ts), the batch query:
 *   • is TRULY UNBOUNDED (no 365-day lookback cap — it scans every completed
 *     deposit / wager / withdrawal in history). The twin matches; the heavy
 *     full-history scan is exactly the load ClickHouse exists to absorb, and
 *     the caller caches it (unstable_cache revalidate 900s).
 *   • restricts withdrawals to `status IN ('completed','shipped')` only (the
 *     detail twin uses the 4-status in-flight liability set — NOT used here).
 *   • gates cardWD with a RELATIONAL depositor join across ALL creators at
 *     once (depositors_per_creator), and matches withdrawn units to creators
 *     via a real JOIN on `acu.game_session_id` (reproducing any per-session
 *     fan-out the PG JOIN produces), not the detail twin's session semi-join.
 *
 * covered_deposits: a completed deposit at time T by real customer U is booked
 * to the creator on U's MOST-RECENT NON-SELF `affiliate_code_usages` row in
 * [T-7d, T]. Replicated with an `ASOF LEFT JOIN` against the non-self acu set
 * (`a.created_at <= d.created_at` → greatest acu time at or before the deposit)
 * plus a 7-day-window filter — byte-exact to PG's DISTINCT ON (lt.id) ...
 * ORDER BY acu.created_at DESC, including the code-switch / outside-window NULL
 * cases. NOTE: this batch lateral uses QUALIFIED `lt.created_at`, so its 7-day
 * window is CORRECT (event-time), unlike the net-ggr quirk.
 *
 * Scopes (mirrored exactly, NOT uniform):
 *   • deposits  — depositing user real (role NOT IN admin,support,creator),
 *     not self, minus blacklist.
 *   • wagers    — acu usage_type='wager', referred user real, not self, minus
 *     blacklist; SUM(wager_amount_usd) per affiliate.
 *   • cardWD    — withdrawn value-units (cards via
 *     card_withdrawal_requests.inventory_item_ids → user_inventory
 *     [source_type IN pack,battle]; session-linked vouchers via voucher_ids →
 *     vouchers [origin IN battle_excess_to_voucher,pack_borrow_to_voucher])
 *     matched to a creator via their acu wager session (referred user real,
 *     not self, minus blacklist), restricted to users with a coverage-
 *     attributed deposit under THAT creator (depositor filter).
 *
 * Final universe = (creator_deposits ∪ creator_wagers ∪ creator_cardwd) keys
 * INTERSECT role='creator' users (PG's FULL OUTER JOIN + `cu.role='creator'`),
 * assembled in TS (same merge-in-code pattern as the net-ggr twin).
 *
 * CH correctness: FINAL + `_peerdb_is_deleted=0` on every mirror table (incl.
 * every join/sub-select/ASOF side); money Decimal end-to-end (toString(sum(...))
 * → caller's Number(...), never Float); blacklist bound `{blacklist:Array(String)}`.
 */

type LifetimePnlRow = {
  creator_user_id: string;
  username: string | null;
  image: string | null;
  total_deposits: string;
  total_wagered: string;
  total_card_withdrawals: string;
};

type IdValueRow = { creator_id: string; value: string };
type CreatorInfoRow = {
  id: string;
  username: string | null;
  image: string | null;
};

// Completed/shipped only — matches the BATCH PG (NOT the detail liability set).
const WD_STATUS_SQL = "('completed','shipped')";

/** Non-self affiliate usages, deduped (FINAL). */
function acuNonselfCte(): string {
  return `acu_nonself AS (
    SELECT referred_user_id AS ruid, affiliate_user_id AS auid, created_at AS acat
    FROM ${CH_DB}.public_affiliate_code_usages FINAL
    WHERE _peerdb_is_deleted = 0 AND referred_user_id <> affiliate_user_id
  )`;
}

/**
 * covered_deposits → attributed_deposits: every completed deposit by a real
 * customer, booked to its covering (most-recent non-self, 7-day-windowed)
 * creator. Shared verbatim by the deposits and cardWD queries.
 */
function attributedDepositsCte(blacklistUFilter: string): string {
  return `elig_deposits AS (
      SELECT lt.user_id AS uid, lt.created_at AS cat, lt.amount AS amt
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = lt.user_id AND u._peerdb_is_deleted = 0
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'deposit'
        AND lt.status = 'completed'
        AND u.role NOT IN ('admin','support','creator')
        ${blacklistUFilter}
    ),
    covered AS (
      SELECT d.uid AS uid, d.amt AS amt, a.auid AS creator_id, a.acat AS acat, d.cat AS cat
      FROM elig_deposits AS d
      ASOF LEFT JOIN acu_nonself AS a
        ON d.uid = a.ruid AND a.acat <= d.cat
    ),
    attributed AS (
      SELECT uid, amt, creator_id
      FROM covered
      WHERE creator_id <> '' AND acat >= cat - INTERVAL 7 DAY
    )`;
}

/** Withdrawn value-units (cards + session-linked vouchers), completed/shipped. */
function withdrawnUnitsCte(): string {
  return `withdrawn_units AS (
      SELECT ui.user_id AS user_id, ui.source_id AS source_id, ui.value_at_obtained AS value
      FROM (
        SELECT arrayJoin(inventory_item_ids) AS item_id
        FROM ${CH_DB}.public_card_withdrawal_requests FINAL
        WHERE _peerdb_is_deleted = 0 AND status IN ${WD_STATUS_SQL}
      ) AS cwr_c
      INNER JOIN ${CH_DB}.public_user_inventory AS ui FINAL
        ON ui.id = cwr_c.item_id AND ui._peerdb_is_deleted = 0
      WHERE ui.source_type IN ('pack','battle')
      UNION ALL
      SELECT v.user_id AS user_id, v.origin_id AS source_id, v.value AS value
      FROM (
        SELECT arrayJoin(voucher_ids) AS voucher_id
        FROM ${CH_DB}.public_card_withdrawal_requests FINAL
        WHERE _peerdb_is_deleted = 0 AND status IN ${WD_STATUS_SQL}
      ) AS cwr_v
      INNER JOIN ${CH_DB}.public_vouchers AS v FINAL
        ON v.id = cwr_v.voucher_id AND v._peerdb_is_deleted = 0
      WHERE v.origin IN ('battle_excess_to_voucher','pack_borrow_to_voucher')
    )`;
}

export async function getAllCreatorsLifetimePnlRowsFromClickHouse(
  blacklist: string[],
): Promise<LifetimePnlRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const blacklistUFilter = hasBlacklist
    ? "AND u.id NOT IN {blacklist:Array(String)}"
    : "";
  const params: Record<string, unknown> = hasBlacklist ? { blacklist } : {};

  const run = (queryName: string, sql: string) =>
    clickhouseRead.query<IdValueRow>({
      queryName,
      sql,
      params,
      timeoutMs: 60_000,
    });

  const depositsSql = `
    WITH ${acuNonselfCte()},
    ${attributedDepositsCte(blacklistUFilter)}
    SELECT creator_id, toString(sum(amt)) AS value
    FROM attributed
    GROUP BY creator_id`;

  const wagersSql = `
    SELECT acu.affiliate_user_id AS creator_id,
           toString(sum(acu.wager_amount_usd)) AS value
    FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
    INNER JOIN ${CH_DB}.public_user AS u FINAL
      ON u.id = acu.referred_user_id AND u._peerdb_is_deleted = 0
    WHERE acu._peerdb_is_deleted = 0
      AND acu.usage_type = 'wager'
      AND u.role NOT IN ('admin','support','creator')
      AND u.id <> acu.affiliate_user_id
      ${blacklistUFilter}
    GROUP BY acu.affiliate_user_id`;

  // cardWD: depositors_per_creator (from attributed deposits) gates the
  // withdrawn units, matched to creators via their acu wager sessions. The
  // real JOIN on acu_w.game_session_id reproduces PG's per-session fan-out;
  // the dpc INNER JOIN is a semi-join (dpc is DISTINCT) = PG's EXISTS.
  const cardwdSql = `
    WITH ${acuNonselfCte()},
    ${attributedDepositsCte(blacklistUFilter)},
    depositors_per_creator AS (
      SELECT DISTINCT creator_id, uid FROM attributed
    ),
    ${withdrawnUnitsCte()}
    SELECT acu_w.affiliate_user_id AS creator_id,
           toString(sum(wu.value)) AS value
    FROM withdrawn_units AS wu
    INNER JOIN ${CH_DB}.public_affiliate_code_usages AS acu_w FINAL
      ON acu_w.game_session_id = wu.source_id
    INNER JOIN ${CH_DB}.public_user AS u FINAL
      ON u.id = acu_w.referred_user_id AND u._peerdb_is_deleted = 0
    INNER JOIN depositors_per_creator AS dpc
      ON dpc.creator_id = acu_w.affiliate_user_id AND dpc.uid = wu.user_id
    WHERE acu_w._peerdb_is_deleted = 0
      AND acu_w.usage_type = 'wager'
      AND u.role NOT IN ('admin','support','creator')
      AND u.id <> acu_w.affiliate_user_id
      ${blacklistUFilter}
    GROUP BY acu_w.affiliate_user_id`;

  const creatorsSql = `
    SELECT id, username, image
    FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0 AND role = 'creator'`;

  const [depRows, wagRows, cardwdRows, creatorRows] = await Promise.all([
    run("creators.lifetimePnl.deposits", depositsSql),
    run("creators.lifetimePnl.wagers", wagersSql),
    run("creators.lifetimePnl.cardwd", cardwdSql),
    clickhouseRead.query<CreatorInfoRow>({
      queryName: "creators.lifetimePnl.creators",
      sql: creatorsSql,
      params,
      timeoutMs: 30_000,
    }),
  ]);

  const depById = new Map(depRows.map((r) => [r.creator_id, r.value]));
  const wagById = new Map(wagRows.map((r) => [r.creator_id, r.value]));
  const cwdById = new Map(cardwdRows.map((r) => [r.creator_id, r.value]));

  // Universe = creators (role='creator') that appear in ANY aggregate.
  // Mirrors PG's FULL OUTER JOIN of the three aggregates + cu.role='creator'.
  const rows: LifetimePnlRow[] = [];
  for (const c of creatorRows) {
    const dep = depById.get(c.id);
    const wag = wagById.get(c.id);
    const cwd = cwdById.get(c.id);
    if (dep === undefined && wag === undefined && cwd === undefined) continue;
    rows.push({
      creator_user_id: c.id,
      username: c.username,
      image: c.image,
      total_deposits: dep ?? "0",
      total_wagered: wag ?? "0",
      total_card_withdrawals: cwd ?? "0",
    });
  }
  return rows;
}
