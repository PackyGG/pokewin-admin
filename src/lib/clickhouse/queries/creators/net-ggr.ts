import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "@/lib/clickhouse/queries/_shared";

/**
 * ClickHouse twin of the 3 attribution scans behind `getAllCreatorsNetGgr`
 * (src/app/(admin)/creators/_queries/all-creators-net-pnl.ts).
 *
 * Returns the SAME raw creator-keyed row bundle the Postgres `Promise.all`
 * produces, so the existing in-code merge (GGR = wager − gamingPayout per
 * creator, cohort legs) runs unchanged on either source via
 * `resolveAdminRead('creators_net_ggr', { pg, ch })`.
 *
 * ─── PG-FAITHFUL attribution (parity-proven cent-exact, TZ=UTC, twice) ──
 *
 * The covering attribution is mirrored EXACTLY from the PG production query,
 * INCLUDING a latent column-resolution quirk in its `coveringLateral`:
 *
 *     ... FROM affiliate_code_usages acu
 *     WHERE acu.referred_user_id = <userCol>
 *       AND acu.created_at <= <tsCol>            -- unqualified!
 *       AND acu.created_at >= <tsCol> - INTERVAL '7 days'
 *     ORDER BY acu.created_at DESC LIMIT 1
 *
 * For the LEDGER and UPGRADER legs the lateral is called with
 * `tsCol = "created_at"`. Inside the subquery the unqualified `created_at`
 * binds to `acu.created_at` (the subquery's own table has that column), so the
 * window collapses to `acu.created_at <= acu.created_at` (always true) and the
 * 7-day event-time window is INERT — those legs attribute every event to the
 * user's MOST-RECENT non-self affiliate EVER (regardless of event time). The
 * INVENTORY leg is called with `tsCol = "obtained_at"`, a column `acu` does NOT
 * have, so there the predicate correctly binds to the outer `user_inventory`
 * row and the 7-day event-time window applies.
 *
 * The twin replicates that behavior so the comparison/cutover is a no-op:
 *   • ledger + upgrader → per-user latest non-self affiliate (`user_creator`),
 *   • inventory         → event-time 7-day window via `ASOF LEFT JOIN`
 *     (one match per event = PG "ORDER BY created_at DESC LIMIT 1", no fan-out).
 *
 * NOTE for the owner: the PG quirk makes ledger/upgrader vs inventory
 * attribution INCONSISTENT (latest-ever vs event-time-windowed). Fixing it
 * (qualifying the timestamp column in the PG lateral, and dropping
 * `user_creator` here for the event-time window on all legs) would change the
 * user-visible /creators + /creator-hub numbers — flagged as a separate
 * correctness decision, NOT done here (the twin must match what ships today).
 *
 * Other semantics mirrored exactly:
 *   • Customer scope = role NOT IN (admin,support,creator) minus blacklist
 *     (`real_users`). The PG `exclStaffSessionFrag` session-window NOT EXISTS
 *     is a documented no-op once creators are dropped wholesale (metrics/
 *     scope.ts), sourced from the backend API, so it is omitted here.
 *   • WAGER_LEG_FILTER: keep every type EXCEPT reward/daily pack opens
 *     (game_type='pack' → packs.pack_type='reward'); reward packs dropped on
 *     the pack_opening arm. The non-wager types pass too, contributing 0 to
 *     both CASE sums but producing the SAME 0-leg ("phantom") creator rows PG
 *     emits, so creator counts match.
 *   • PAYOUT_LEG_FILTER: source_type IN ('pack','battle') AND source_id NOT IN
 *     reward_pack_sessions.
 *   • wager  = Σ|amount| for type IN (pack_opening,battle_bet,battle_sponsorship)
 *   • ledger_payout = Σ|amount| for type IN (battle_refund,battle_excess_to_voucher)
 *   • inv_payout = Σ value_at_obtained ; upg_wager/upg_payout = Σ bet/won_amount.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`; money Decimal end-to-end
 * (toString(sum(...)) → toNumber in TS, never Float). `since = null` = the
 * lifetime ("all") window (no lower bound), matching periodToSinceDate.
 */

type NetGgrLedgerRow = {
  creator_id: string;
  wager: string;
  ledger_payout: string;
};
type NetGgrInvRow = { creator_id: string; inv_payout: string };
type NetGgrUpgRow = {
  creator_id: string;
  upg_wager: string;
  upg_payout: string;
};
type NetGgrScans = {
  ledgerRows: NetGgrLedgerRow[];
  invRows: NetGgrInvRow[];
  upgRows: NetGgrUpgRow[];
};

function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
    SELECT id FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND role NOT IN ('admin','support','creator')
      ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
  )`;
}

const CREATORS_CTE = `creators AS (
  SELECT id FROM ${CH_DB}.public_user FINAL
  WHERE _peerdb_is_deleted = 0 AND role = 'creator'
)`;

const REWARD_PACK_SESSIONS_CTE = `reward_pack_sessions AS (
  SELECT gs.id AS id
  FROM ${CH_DB}.public_game_sessions AS gs FINAL
  INNER JOIN ${CH_DB}.public_packs AS p FINAL
          ON p.id = gs.game_id AND p.pack_type = 'reward' AND p._peerdb_is_deleted = 0
  WHERE gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
)`;

/** Non-self affiliate usages, deduped (FINAL). Base for both attribution shapes. */
const ACU_NONSELF_CTE = `acu_nonself AS (
  SELECT referred_user_id, affiliate_user_id, created_at
  FROM ${CH_DB}.public_affiliate_code_usages FINAL
  WHERE _peerdb_is_deleted = 0 AND referred_user_id <> affiliate_user_id
)`;

/**
 * Per-user MOST-RECENT non-self affiliate ever (= PG ledger/upgrader lateral,
 * whose 7-day window is inert). One row per user, joined by user_id — no
 * per-event fan-out.
 */
const USER_CREATOR_CTE = `user_creator AS (
  SELECT referred_user_id AS uid, argMax(affiliate_user_id, created_at) AS creator_id
  FROM acu_nonself
  GROUP BY referred_user_id
)`;

/** Event-time covering join (inventory leg): the single most-recent acu at or
 * before the event ts, restricted to the 7-day pre-window. */
const ASOF_JOIN = `ASOF LEFT JOIN acu_nonself AS acu
        ON d.uid = acu.referred_user_id AND d.ts >= acu.created_at`;
const ASOF_COV = `if(acu.created_at >= d.ts - INTERVAL 7 DAY, acu.affiliate_user_id, '') AS creator_id`;

export async function getAllCreatorsNetGgrScansFromClickHouse(
  blacklist: string[],
  since: Date | null,
): Promise<NetGgrScans> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    ...(hasBlacklist ? { blacklist } : {}),
    ...(since !== null ? { since: chDateTime(since) } : {}),
  };
  const sinceLedger =
    since !== null ? "AND lt.created_at >= {since:DateTime64(3)}" : "";
  const sinceInv =
    since !== null ? "AND ui.obtained_at >= {since:DateTime64(3)}" : "";
  const sinceUpg =
    since !== null ? "AND ug.created_at >= {since:DateTime64(3)}" : "";

  const run = <T>(queryName: string, sql: string) =>
    clickhouseRead.query<T>({ queryName, sql, params, timeoutMs: 30_000 });

  const [ledgerRows, invRows, upgRows] = await Promise.all([
    // 1) Ledger wager + ledger gaming payout, per covering creator
    //    (latest-ever affiliate — PG-faithful).
    run<NetGgrLedgerRow>(
      "creators.netGgr.ledger",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE}, ${REWARD_PACK_SESSIONS_CTE}, ${ACU_NONSELF_CTE}, ${USER_CREATOR_CTE},
       d AS (
         SELECT lt.user_id AS uid, lt.type AS type, abs(lt.amount) AS amount
         FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
         WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
           ${sinceLedger}
           AND lt.user_id IN (SELECT id FROM real_users)
           AND (
             lt.type NOT IN ('pack_opening','battle_bet','battle_sponsorship')
             OR (lt.type = 'pack_opening'
                 AND (isNull(lt.game_session_id)
                      OR lt.game_session_id NOT IN (SELECT id FROM reward_pack_sessions)))
             OR lt.type = 'battle_bet'
             OR lt.type = 'battle_sponsorship'
           )
       ),
       mapped AS (
         SELECT d.type AS type, d.amount AS amount, uc.creator_id AS creator_id
         FROM d LEFT JOIN user_creator AS uc ON uc.uid = d.uid
       )
       SELECT creator_id,
              toString(sum(if(type IN ('pack_opening','battle_bet','battle_sponsorship'), amount, toDecimal128(0, 2)))) AS wager,
              toString(sum(if(type IN ('battle_refund','battle_excess_to_voucher'), amount, toDecimal128(0, 2)))) AS ledger_payout
       FROM mapped
       WHERE creator_id <> '' AND creator_id IN (SELECT id FROM creators)
       GROUP BY creator_id`,
    ),

    // 2) Inventory pack/battle payout, per covering creator (event-time 7-day
    //    window via ASOF — PG-faithful for the obtained_at-keyed leg).
    run<NetGgrInvRow>(
      "creators.netGgr.inventory",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE}, ${REWARD_PACK_SESSIONS_CTE}, ${ACU_NONSELF_CTE},
       d AS (
         SELECT ui.user_id AS uid, ui.value_at_obtained AS value, ui.obtained_at AS ts
         FROM ${CH_DB}.public_user_inventory AS ui FINAL
         WHERE ui._peerdb_is_deleted = 0
           AND ui.source_type IN ('pack','battle')
           AND (isNull(ui.source_id) OR ui.source_id NOT IN (SELECT id FROM reward_pack_sessions))
           ${sinceInv}
           AND ui.user_id IN (SELECT id FROM real_users)
       ),
       mapped AS (
         SELECT d.value AS value, ${ASOF_COV}
         FROM d ${ASOF_JOIN}
       )
       SELECT creator_id, toString(sum(value)) AS inv_payout
       FROM mapped
       WHERE creator_id <> '' AND creator_id IN (SELECT id FROM creators)
       GROUP BY creator_id`,
    ),

    // 3) Upgrader plays, per covering creator (latest-ever affiliate — PG-faithful).
    run<NetGgrUpgRow>(
      "creators.netGgr.upgrader",
      `WITH ${realUsersCte(hasBlacklist)}, ${CREATORS_CTE}, ${ACU_NONSELF_CTE}, ${USER_CREATOR_CTE},
       d AS (
         SELECT ug.user_id AS uid, ug.bet_amount AS bet, ug.won_amount AS won
         FROM ${CH_DB}.public_upgrader_games AS ug FINAL
         WHERE ug._peerdb_is_deleted = 0
           ${sinceUpg}
           AND ug.user_id IN (SELECT id FROM real_users)
       ),
       mapped AS (
         SELECT d.bet AS bet, d.won AS won, uc.creator_id AS creator_id
         FROM d LEFT JOIN user_creator AS uc ON uc.uid = d.uid
       )
       SELECT creator_id,
              toString(sum(bet)) AS upg_wager,
              toString(sum(won)) AS upg_payout
       FROM mapped
       WHERE creator_id <> '' AND creator_id IN (SELECT id FROM creators)
       GROUP BY creator_id`,
    ),
  ]);

  return { ledgerRows, invRows, upgRows };
}
