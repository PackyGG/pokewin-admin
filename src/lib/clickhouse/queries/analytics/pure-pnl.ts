import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";

/**
 * ClickHouse twin of `getPackBattlePurePnl` (`@/lib/queries/pnl.ts`) — the
 * /analytics?tab=pure-pnl "Pack & Battle Pure P&L" panel.
 *
 * PARITY with the canonical Postgres definition (pnl.ts getPackBattlePurePnl):
 *
 *   pure_pnl = wager_in − payouts_out      (positive = house gained)
 *
 *   • packWager   = Σ |amount| of ledger pack_opening rows in window.
 *   • battleWager = Σ |amount| of ledger battle_bet + battle_sponsorship rows.
 *   • packPayouts = Σ value_at_obtained of user_inventory source_type='pack'
 *                   rows obtained in window.
 *   • battlePayouts = Σ value_at_obtained of source_type='battle' inventory
 *                   rows + Σ |battle_excess_to_voucher| + Σ |battle_refund|
 *                   ledger rows (the two GAMING_PAYOUT settlement legs the
 *                   inventory card under-counts / does not carry).
 *   • packPnl   = packWager − packPayouts; battlePnl = battleWager − battlePayouts.
 *
 * SCOPE: real customers only — wholesale 3-role exclusion
 * (`role NOT IN ('admin','support','creator')`) + excluded-users blacklist —
 * mirrored from the PG twin (creator plays are house-funded promo content).
 * This is the `customerScopeCte` wholesale scope.
 *
 * BORROW-EXCLUSIVE basis (mirrors the PG twin exactly, NOT the borrow-inclusive
 * window-metrics gaming legs): borrow plays drop out ENTIRELY on BOTH sides.
 *   • pack_opening wager: kept unless the row's description contains "borrow"
 *     (case-insensitive) or it is a reward/daily pack open (game_session_id in
 *     the reward-pack session set).
 *   • battle_bet wager: kept only when its game_session_id belongs to a battle
 *     with borrow_percentage = 0 (the non-borrow battle session set).
 *   • battle_sponsorship: counted directly (NULL game_session_id, all
 *     sponsored battles are borrow_percentage=0 — owner-confirmed).
 *   • battle_excess_to_voucher / battle_refund: counted unconditionally (battle
 *     settlement legs, no borrow flag of their own).
 *   • inventory payout: pack cards kept only if source_id is a non-borrow pack
 *     session; battle cards only if a non-borrow battle session; reward-pack
 *     won cards excluded.
 *
 * Windows: h24 / d3 / d7 (rolling lower bound on created_at / obtained_at) and
 * `all` (lifetime, no lower bound) — mirrored from the PG twin. No forward /
 * unsettled horizon exists here, so no cap is applied (matches PG).
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` on EVERY mirrored
 * table (incl. the borrow/reward session sub-selects); money stays Decimal
 * (`toString(sum(...))` → `toNumber`), never Float; conditional zero is
 * `toDecimal128(0, 2)` so the cents scale is preserved (§5b). The blacklist is
 * passed in by the caller (no Postgres client imported here).
 */

export type PackBattlePnlRowCh = {
  packWager: number;
  packPayouts: number;
  packPnl: number;
  battleWager: number;
  battlePayouts: number;
  battlePnl: number;
  totalWager: number;
  totalPayouts: number;
  totalPnl: number;
};

export type PackBattlePnlWindowsCh = {
  h24: PackBattlePnlRowCh;
  d3: PackBattlePnlRowCh;
  d7: PackBattlePnlRowCh;
  all: PackBattlePnlRowCh;
};

/**
 * Reward/daily-pack session set — `game_sessions` for reward-pack opens
 * (`game_type='pack'` → `packs.pack_type='reward'`). Used to drop $0-wager
 * giveaway opens from the pack wager leg (game_session_id) AND the won-card
 * inventory leg (source_id). FINAL + `_peerdb_is_deleted = 0` on both tables.
 */
const REWARD_PACK_SESSIONS = `(
        SELECT gs.id
        FROM ${CH_DB}.public_game_sessions AS gs FINAL
        INNER JOIN ${CH_DB}.public_packs AS p FINAL
          ON p.id = gs.game_id AND p._peerdb_is_deleted = 0 AND p.pack_type = 'reward'
        WHERE gs._peerdb_is_deleted = 0
          AND gs.game_type = 'pack'
      )`;

/**
 * Non-borrow pack session set — pack_opening ledger rows whose description does
 * NOT contain "borrow" (case-insensitive). Mirrors the PG `nonBorrowPackSessions`
 * sub-select; used as a positive-membership gate for the pack inventory payout.
 */
const NON_BORROW_PACK_SESSIONS = `(
        SELECT game_session_id
        FROM ${CH_DB}.public_ledger_transactions FINAL
        WHERE _peerdb_is_deleted = 0
          AND type = 'pack_opening'
          AND status = 'completed'
          AND game_session_id IS NOT NULL
          AND (description IS NULL OR description NOT ILIKE '%borrow%')
      )`;

/**
 * Non-borrow battle session set — battle_participants whose linked battle has
 * borrow_percentage = 0. Mirrors the PG `nonBorrowBattleSessions` sub-select.
 */
const NON_BORROW_BATTLE_SESSIONS = `(
        SELECT bp.game_session_id
        FROM ${CH_DB}.public_battle_participants AS bp FINAL
        INNER JOIN ${CH_DB}.public_battles AS b FINAL
          ON b.id = bp.battle_id AND b._peerdb_is_deleted = 0
        WHERE bp._peerdb_is_deleted = 0
          AND coalesce(b.borrow_percentage, 0) = 0
      )`;

type LedgerRow = {
  pack_wager_h24: string; pack_wager_d3: string; pack_wager_d7: string; pack_wager_all: string;
  battle_wager_h24: string; battle_wager_d3: string; battle_wager_d7: string; battle_wager_all: string;
  battle_excess_h24: string; battle_excess_d3: string; battle_excess_d7: string; battle_excess_all: string;
  battle_refund_h24: string; battle_refund_d3: string; battle_refund_d7: string; battle_refund_all: string;
};
type InvRow = {
  pack_payout_h24: string; pack_payout_d3: string; pack_payout_d7: string; pack_payout_all: string;
  battle_payout_h24: string; battle_payout_d3: string; battle_payout_d7: string; battle_payout_all: string;
};

const ZERO_LEDGER: LedgerRow = {
  pack_wager_h24: "0", pack_wager_d3: "0", pack_wager_d7: "0", pack_wager_all: "0",
  battle_wager_h24: "0", battle_wager_d3: "0", battle_wager_d7: "0", battle_wager_all: "0",
  battle_excess_h24: "0", battle_excess_d3: "0", battle_excess_d7: "0", battle_excess_all: "0",
  battle_refund_h24: "0", battle_refund_d3: "0", battle_refund_d7: "0", battle_refund_all: "0",
};
const ZERO_INV: InvRow = {
  pack_payout_h24: "0", pack_payout_d3: "0", pack_payout_d7: "0", pack_payout_all: "0",
  battle_payout_h24: "0", battle_payout_d3: "0", battle_payout_d7: "0", battle_payout_all: "0",
};

export async function getPackBattlePurePnlFromClickHouse(
  blacklist: string[],
  now: Date = new Date(),
): Promise<PackBattlePnlWindowsCh> {
  const t = now.getTime();
  const h24 = chDateTime(new Date(t - 24 * 60 * 60 * 1000));
  const d3 = chDateTime(new Date(t - 3 * 24 * 60 * 60 * 1000));
  const d7 = chDateTime(new Date(t - 7 * 24 * 60 * 60 * 1000));

  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist, h24, d3, d7 };
  const realUsers = customerScopeCte({ hasBlacklist });

  // Wager side + the two battle-settlement payout legs (battle_excess_to_voucher
  // + battle_refund). Conditional zero = toDecimal128(0, 2) so cents survive.
  const ledgerSql = `
    WITH ${realUsers}
    SELECT
      toString(sum(if(lt.type = 'pack_opening' AND lt.created_at >= {h24:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager_h24,
      toString(sum(if(lt.type = 'pack_opening' AND lt.created_at >= {d3:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager_d3,
      toString(sum(if(lt.type = 'pack_opening' AND lt.created_at >= {d7:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager_d7,
      toString(sum(if(lt.type = 'pack_opening',                                          abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager_all,
      toString(sum(if(lt.type IN ('battle_bet','battle_sponsorship') AND lt.created_at >= {h24:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager_h24,
      toString(sum(if(lt.type IN ('battle_bet','battle_sponsorship') AND lt.created_at >= {d3:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager_d3,
      toString(sum(if(lt.type IN ('battle_bet','battle_sponsorship') AND lt.created_at >= {d7:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager_d7,
      toString(sum(if(lt.type IN ('battle_bet','battle_sponsorship'),                                          abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager_all,
      toString(sum(if(lt.type = 'battle_excess_to_voucher' AND lt.created_at >= {h24:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2)))) AS battle_excess_h24,
      toString(sum(if(lt.type = 'battle_excess_to_voucher' AND lt.created_at >= {d3:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS battle_excess_d3,
      toString(sum(if(lt.type = 'battle_excess_to_voucher' AND lt.created_at >= {d7:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS battle_excess_d7,
      toString(sum(if(lt.type = 'battle_excess_to_voucher',                                          abs(lt.amount), toDecimal128(0, 2)))) AS battle_excess_all,
      toString(sum(if(lt.type = 'battle_refund' AND lt.created_at >= {h24:DateTime64(6)}, abs(lt.amount), toDecimal128(0, 2)))) AS battle_refund_h24,
      toString(sum(if(lt.type = 'battle_refund' AND lt.created_at >= {d3:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS battle_refund_d3,
      toString(sum(if(lt.type = 'battle_refund' AND lt.created_at >= {d7:DateTime64(6)},  abs(lt.amount), toDecimal128(0, 2)))) AS battle_refund_d7,
      toString(sum(if(lt.type = 'battle_refund',                                          abs(lt.amount), toDecimal128(0, 2)))) AS battle_refund_all
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','battle_excess_to_voucher','battle_refund')
      AND lt.user_id IN (SELECT id FROM real_users)
      AND (
        (lt.type = 'pack_opening'
         AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
         AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN ${REWARD_PACK_SESSIONS}))
        OR (lt.type = 'battle_bet' AND lt.game_session_id IN ${NON_BORROW_BATTLE_SESSIONS})
        OR lt.type = 'battle_sponsorship'
        OR lt.type = 'battle_excess_to_voucher'
        OR lt.type = 'battle_refund'
      )`;

  // Inventory payout side (pack + battle won cards). Borrow + reward-pack
  // exclusions mirror the wager-side filter so both sides drop the same plays.
  const invSql = `
    WITH ${realUsers}
    SELECT
      toString(sum(if(ui.source_type = 'pack' AND ui.obtained_at >= {h24:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS pack_payout_h24,
      toString(sum(if(ui.source_type = 'pack' AND ui.obtained_at >= {d3:DateTime64(6)},  ui.value_at_obtained, toDecimal128(0, 2)))) AS pack_payout_d3,
      toString(sum(if(ui.source_type = 'pack' AND ui.obtained_at >= {d7:DateTime64(6)},  ui.value_at_obtained, toDecimal128(0, 2)))) AS pack_payout_d7,
      toString(sum(if(ui.source_type = 'pack',                                           ui.value_at_obtained, toDecimal128(0, 2)))) AS pack_payout_all,
      toString(sum(if(ui.source_type = 'battle' AND ui.obtained_at >= {h24:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS battle_payout_h24,
      toString(sum(if(ui.source_type = 'battle' AND ui.obtained_at >= {d3:DateTime64(6)},  ui.value_at_obtained, toDecimal128(0, 2)))) AS battle_payout_d3,
      toString(sum(if(ui.source_type = 'battle' AND ui.obtained_at >= {d7:DateTime64(6)},  ui.value_at_obtained, toDecimal128(0, 2)))) AS battle_payout_d7,
      toString(sum(if(ui.source_type = 'battle',                                           ui.value_at_obtained, toDecimal128(0, 2)))) AS battle_payout_all
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.source_type IN ('pack','battle')
      AND ui.user_id IN (SELECT id FROM real_users)
      AND (
        (ui.source_type = 'pack' AND ui.source_id IN ${NON_BORROW_PACK_SESSIONS})
        OR (ui.source_type = 'battle' AND ui.source_id IN ${NON_BORROW_BATTLE_SESSIONS})
      )
      AND (ui.source_id IS NULL OR ui.source_id NOT IN ${REWARD_PACK_SESSIONS})`;

  const [ledgerRows, invRows] = await Promise.all([
    clickhouseRead.query<LedgerRow>({
      queryName: "analytics.purePnl.ledger",
      sql: ledgerSql,
      params,
    }),
    clickhouseRead.query<InvRow>({
      queryName: "analytics.purePnl.inventory",
      sql: invSql,
      params,
    }),
  ]);

  const l = ledgerRows[0] ?? ZERO_LEDGER;
  const i = invRows[0] ?? ZERO_INV;

  const buildRow = (
    packWagerKey: keyof LedgerRow,
    battleWagerKey: keyof LedgerRow,
    packPayoutKey: keyof InvRow,
    battlePayoutKey: keyof InvRow,
    battleExcessKey: keyof LedgerRow,
    battleRefundKey: keyof LedgerRow,
  ): PackBattlePnlRowCh => {
    const packWager = toNumber(l[packWagerKey]);
    const battleWager = toNumber(l[battleWagerKey]);
    const packPayouts = toNumber(i[packPayoutKey]);
    const battlePayouts =
      toNumber(i[battlePayoutKey]) +
      toNumber(l[battleExcessKey]) +
      toNumber(l[battleRefundKey]);
    const packPnl = packWager - packPayouts;
    const battlePnl = battleWager - battlePayouts;
    return {
      packWager,
      packPayouts,
      packPnl,
      battleWager,
      battlePayouts,
      battlePnl,
      totalWager: packWager + battleWager,
      totalPayouts: packPayouts + battlePayouts,
      totalPnl: packPnl + battlePnl,
    };
  };

  return {
    h24: buildRow("pack_wager_h24", "battle_wager_h24", "pack_payout_h24", "battle_payout_h24", "battle_excess_h24", "battle_refund_h24"),
    d3:  buildRow("pack_wager_d3",  "battle_wager_d3",  "pack_payout_d3",  "battle_payout_d3",  "battle_excess_d3",  "battle_refund_d3"),
    d7:  buildRow("pack_wager_d7",  "battle_wager_d7",  "pack_payout_d7",  "battle_payout_d7",  "battle_excess_d7",  "battle_refund_d7"),
    all: buildRow("pack_wager_all", "battle_wager_all", "pack_payout_all", "battle_payout_all", "battle_excess_all", "battle_refund_all"),
  };
}
