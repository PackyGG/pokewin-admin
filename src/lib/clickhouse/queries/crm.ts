import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, customerScopeCte } from "./_shared";

/**
 * ClickHouse twin of the Player-CRM per-customer aggregate
 * (`computeCrmRowsPg` in src/lib/queries/crm.ts). Returns the SAME per-user
 * row shape so the caller's pure `bucketCrmSnapshot` produces an identical
 * snapshot — the only difference between the two paths is the read engine.
 *
 * Parity contract with the Postgres twin (all replicated EXACTLY):
 *   • Scope = real customers: role NOT IN ('admin','support','creator') +
 *     the excluded-users blacklist. (Creators are dropped wholesale, so the
 *     PG twin's creator session-window carve-out is a no-op here and is
 *     intentionally omitted — same reasoning as `customerScopeCte`.)
 *   • Borrow-corrected wager + payout: pack opens whose ledger description
 *     contains "borrow" are dropped on BOTH the wager and inventory-payout
 *     sides; battle legs use the non-borrow battle sessions
 *     (borrow_percentage = 0); battle_sponsorship is counted directly.
 *   • Sources: deposits / card withdrawals / WAGER_TYPES wager (plays = 1 per
 *     row) / GAMING_PAYOUT_TYPES ledger payout / pack+battle inventory payout /
 *     upgrader bet+win.
 *   • A single `anchor` instant (passed in) bounds the 365-day window and
 *     drives recency/signup, so this is wall-clock-identical to the PG twin.
 *
 * ClickHouse correctness (PeerDB SharedReplacingMergeTree mirrors): FINAL +
 * `_peerdb_is_deleted = 0` on every public_* table; money summed as Decimal and
 * returned via toString → parsed with toNumber upstream (never Float), so money
 * parity is exact to the cent. Recency/signup match the PG `(epoch/86400)::int`
 * (round half away from zero, non-negative) via micro-precision
 * `floor(Δμs / 86400e6 + 0.5)`.
 *
 * CQRS boundary: imports NO Postgres/Prisma client. The blacklist is passed in
 * by the caller (resolved from the admin DB), so this stays a pure CH read.
 */

// Mirrors LIFETIME_LOOKBACK_DAYS in src/lib/queries/crm.ts (kept local so this
// pure CH read imports nothing from the Postgres side).
const LIFETIME_LOOKBACK_DAYS = 365;

// Canonical ledger sets (mirror @/lib/metrics WAGER_TYPES / GAMING_PAYOUT_TYPES;
// inlined so this CH read stays free of the Prisma-coupled metrics module).
const WAGER_TYPES = ["pack_opening", "battle_bet", "battle_sponsorship"];
const GAMING_PAYOUT_TYPES = ["battle_refund", "battle_excess_to_voucher"];

export type CrmCustomerRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
  withdrawals: string;
  wager: string;
  payout: string;
  plays: number;
  recency_days: number;
  signup_days: number;
};

type RawChRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  deposits: string;
  withdrawals: string;
  wager: string;
  payout: string;
  plays: string;
  recency_days: string;
  signup_days: string;
};

export async function getCrmRowsFromClickHouse(
  anchor: Date,
  blacklist: string[],
): Promise<CrmCustomerRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const cutoff = new Date(
    anchor.getTime() - LIFETIME_LOOKBACK_DAYS * 86400 * 1000,
  );
  const params: Record<string, unknown> = {
    blacklist,
    anchor: chDateTime(anchor),
    cutoff: chDateTime(cutoff),
  };

  const wagerTypeList = WAGER_TYPES.map((t) => `'${t}'`).join(",");
  const payoutTypeList = GAMING_PAYOUT_TYPES.map((t) => `'${t}'`).join(",");

  const sql = `
    WITH
      ${customerScopeCte({ hasBlacklist })},
      non_borrow_pack_sessions AS (
        SELECT game_session_id
        FROM ${CH_DB}.public_ledger_transactions FINAL
        WHERE _peerdb_is_deleted = 0
          AND type = 'pack_opening' AND status = 'completed'
          AND game_session_id IS NOT NULL
          AND (description IS NULL OR description NOT ILIKE '%borrow%')
      ),
      non_borrow_battle_sessions AS (
        SELECT bp.game_session_id AS game_session_id
        FROM ${CH_DB}.public_battle_participants AS bp FINAL
        INNER JOIN ${CH_DB}.public_battles AS b FINAL ON b.id = bp.battle_id
        WHERE bp._peerdb_is_deleted = 0 AND b._peerdb_is_deleted = 0
          AND coalesce(b.borrow_percentage, 0) = 0
      ),
      events AS (
        SELECT lt.user_id AS user_id,
               toDecimal128(abs(lt.amount), 2) AS deposits,
               toDecimal128(0, 2) AS withdrawals,
               toDecimal128(0, 2) AS wager,
               toDecimal128(0, 2) AS payout,
               toInt64(0) AS plays,
               lt.created_at AS act_ts
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
          AND lt.type = 'deposit'
          AND lt.user_id IN (SELECT id FROM real_users)
          AND lt.created_at >= {cutoff:DateTime64(6)}

        UNION ALL
        SELECT lt.user_id, toDecimal128(0, 2), toDecimal128(abs(lt.amount), 2),
               toDecimal128(0, 2), toDecimal128(0, 2), toInt64(0), lt.created_at
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
          AND lt.type = 'card_withdrawal'
          AND lt.user_id IN (SELECT id FROM real_users)
          AND lt.created_at >= {cutoff:DateTime64(6)}

        UNION ALL
        SELECT lt.user_id, toDecimal128(0, 2), toDecimal128(0, 2),
               toDecimal128(abs(lt.amount), 2), toDecimal128(0, 2), toInt64(1), lt.created_at
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
          AND lt.type IN (${wagerTypeList})
          AND lt.user_id IN (SELECT id FROM real_users)
          AND (
            (lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
            OR (lt.type = 'battle_bet' AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
            OR lt.type = 'battle_sponsorship'
          )
          AND lt.created_at >= {cutoff:DateTime64(6)}

        UNION ALL
        SELECT lt.user_id, toDecimal128(0, 2), toDecimal128(0, 2),
               toDecimal128(0, 2), toDecimal128(abs(lt.amount), 2), toInt64(0), lt.created_at
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0 AND lt.status = 'completed'
          AND lt.type IN (${payoutTypeList})
          AND lt.user_id IN (SELECT id FROM real_users)
          AND lt.created_at >= {cutoff:DateTime64(6)}

        UNION ALL
        SELECT ui.user_id, toDecimal128(0, 2), toDecimal128(0, 2),
               toDecimal128(0, 2), toDecimal128(ui.value_at_obtained, 2), toInt64(0), ui.obtained_at
        FROM ${CH_DB}.public_user_inventory AS ui FINAL
        WHERE ui._peerdb_is_deleted = 0
          AND ui.source_type IN ('pack','battle')
          AND ui.user_id IN (SELECT id FROM real_users)
          AND (
            (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
            OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
          )
          AND ui.obtained_at >= {cutoff:DateTime64(6)}

        UNION ALL
        SELECT ug.user_id, toDecimal128(0, 2), toDecimal128(0, 2),
               toDecimal128(ug.bet_amount, 2),
               ifNull(toDecimal128(ug.won_amount, 2), toDecimal128(0, 2)), toInt64(0), ug.created_at
        FROM ${CH_DB}.public_upgrader_games AS ug FINAL
        WHERE ug._peerdb_is_deleted = 0
          AND ug.user_id IN (SELECT id FROM real_users)
          AND ug.created_at >= {cutoff:DateTime64(6)}
      )
    SELECT
      u.id AS user_id,
      u.username AS username,
      u.image AS image,
      toString(sum(e.deposits)) AS deposits,
      toString(sum(e.withdrawals)) AS withdrawals,
      toString(sum(e.wager)) AS wager,
      toString(sum(e.payout)) AS payout,
      toString(toInt32(sum(e.plays))) AS plays,
      toString(toInt32(floor((toUnixTimestamp64Micro({anchor:DateTime64(6)}) - toUnixTimestamp64Micro(max(e.act_ts))) / 86400000000.0 + 0.5))) AS recency_days,
      toString(toInt32(floor((toUnixTimestamp64Micro({anchor:DateTime64(6)}) - toUnixTimestamp64Micro(u.created_at)) / 86400000000.0 + 0.5))) AS signup_days
    FROM events AS e
    INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = e.user_id
    WHERE u._peerdb_is_deleted = 0
    GROUP BY u.id, u.username, u.image, u.created_at
    HAVING sum(e.deposits) > 0 OR sum(e.wager) > 0`;

  const rows = await clickhouseRead.query<RawChRow>({
    queryName: "crm.snapshot.rows",
    sql,
    params,
    timeoutMs: 30_000,
  });

  return rows.map((r) => ({
    user_id: r.user_id,
    username: r.username,
    image: r.image,
    deposits: r.deposits,
    withdrawals: r.withdrawals,
    wager: r.wager,
    payout: r.payout,
    plays: Number(r.plays),
    recency_days: Number(r.recency_days),
    signup_days: Number(r.signup_days),
  }));
}
