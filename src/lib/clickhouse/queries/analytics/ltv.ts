import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of `getCreatorLtv`
 * (`src/lib/queries/analytics-ltv.ts`) — the /analytics?tab=ltv "Creator true
 * LTV" ranking.
 *
 * PARITY with the canonical Postgres definition:
 *   • creators            = `public_user` rows with role = 'creator' (NO staff
 *                           / blacklist filter on the creators themselves).
 *   • referred users      = distinct (creator, referred_user) pairs from
 *                           `affiliate_code_usages` where the affiliate is a
 *                           creator and the referred user is in scope
 *                           (`role NOT IN ('admin','support')` + blacklist).
 *   • referredUsers       = COUNT of those distinct referred users per creator.
 *   • grossPlatformPnl    = Σ|amount| over referred-user wager-type ledger rows
 *                           − Σ|amount| over referred-user payout-type rows
 *                           (status='completed', period-bounded).
 *   • creatorCost         = Σ GREATEST(balance_after − balance_before, 0) over
 *                           the creator's OWN affiliate_claim / creator_tip /
 *                           admin_balance_adjustment rows (status='completed',
 *                           period-bounded), EXCLUDING fake-balance
 *                           `official_stream` admin_balance_adjustment rows.
 *   • netRoi / roiMultiple / totals are derived in TS exactly as the PG twin.
 *
 * The period (7d/30d/90d/all) scopes BOTH the referred-user ledger and the
 * creator-payout ledger via `created_at >= NOW() − INTERVAL N days` (no bound
 * for `all`).
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0`.
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, parsed via
 *     toNumber() in TS — never Float — so parity is exact to the cent. Scale-2
 *     zero branches use `toDecimal128(0, 2)` so an `if()`/`ifNull` zero never
 *     truncates the Decimal cents.
 *   • Unmatched LEFT JOIN aggregates resolve to NULL (`join_use_nulls = 1`) and
 *     are folded to a scale-2 zero, matching PG's `COALESCE(..., 0)`.
 *   • `metadata` (PG jsonb) is a Nullable ClickHouse String; `metadata->>'key'`
 *     maps to `JSONExtractString(ifNull(metadata, ''), 'key')`. The `ifNull`
 *     guard is CRITICAL for the NEGATED official_stream test: a NULL `metadata`
 *     row (every legacy uncategorized adjustment) makes a bare
 *     `JSONExtractString(NULL, …)` return NULL, which propagates through
 *     `= 'official_stream'` / `AND` / `NOT` / `if()` and silently DROPS the row
 *     from the sum (3VL trap). Feeding `''` yields '' ≠ 'official_stream' →
 *     FALSE, so the negation KEEPS uncategorized rows — exactly like the PG
 *     twin's `IS NOT NULL`-guarded predicate.
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client — it is a
 * pure ClickHouse read. `now` is injected so a parity harness can feed the
 * IDENTICAL period cutoff to both engines.
 */

export type LtvPeriodCh = "7d" | "30d" | "90d" | "all";

export type CreatorLtvRowCh = {
  userId: string;
  username: string | null;
  code: string | null;
  referredUsers: number;
  grossPlatformPnl: number;
  creatorCost: number;
  netRoi: number;
  roiMultiple: number | null;
};

export type CreatorLtvDataCh = {
  period: LtvPeriodCh;
  rows: CreatorLtvRowCh[];
  totals: {
    grossPlatformPnl: number;
    creatorCost: number;
    netRoi: number;
    profitableCreators: number;
    losingCreators: number;
  };
};

const MS_PER_DAY = 86_400_000;

const OFFICIAL_STREAM_CATEGORY = "official_stream";

const PAYOUT_TYPES_CH = [
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_credit",
  "deposit_bonus",
  "race_prize",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "rain_win",
  "waitlist_prize",
  "creator_tip",
  "voucher_redeemed",
  "voucher_exchange",
  "exchange_excess_to_voucher",
  "battle_excess_to_voucher",
  "battle_refund",
  "upgrader_payout",
]
  .map((t) => `'${t}'`)
  .join(",");

const WAGER_TYPES_CH = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "upgrader_bet",
  "withdrawal_shipping_fee",
]
  .map((t) => `'${t}'`)
  .join(",");

function daysForPeriod(period: LtvPeriodCh): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

type LtvSqlRow = {
  user_id: string;
  username: string | null;
  affiliate_code: string | null;
  referred_users: string;
  gross_platform_pnl: string;
  creator_cost: string;
};

export async function getCreatorLtvFromClickHouse(
  period: LtvPeriodCh,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CreatorLtvDataCh> {
  const days = daysForPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  let periodClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * MS_PER_DAY));
    periodClause = "AND lt.created_at >= {cutoff:DateTime64(6)}";
  }
  const referredBlacklist = hasBlacklist
    ? "AND id NOT IN {blacklist:Array(String)}"
    : "";

  const sql = `
    WITH
      creators AS (
        SELECT id AS user_id, username, affiliate_code
        FROM ${CH_DB}.public_user FINAL
        WHERE _peerdb_is_deleted = 0
          AND role = 'creator'
      ),
      real_referred AS (
        SELECT id
        FROM ${CH_DB}.public_user FINAL
        WHERE _peerdb_is_deleted = 0
          AND role NOT IN ('admin','support')
          ${referredBlacklist}
      ),
      refs_distinct AS (
        SELECT DISTINCT
          acu.affiliate_user_id AS creator_id,
          acu.referred_user_id AS referred_user_id
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        INNER JOIN creators cr ON cr.user_id = acu.affiliate_user_id
        WHERE acu._peerdb_is_deleted = 0
          AND acu.referred_user_id IN (SELECT id FROM real_referred)
      ),
      ref_counts AS (
        SELECT creator_id, count() AS cnt
        FROM refs_distinct
        GROUP BY creator_id
      ),
      referred_ledger AS (
        SELECT
          rd.creator_id AS creator_id,
          sum(if(lt.type IN (${PAYOUT_TYPES_CH}), abs(lt.amount), toDecimal128(0, 2))) AS payouts,
          sum(if(lt.type IN (${WAGER_TYPES_CH}), abs(lt.amount), toDecimal128(0, 2))) AS wagers
        FROM refs_distinct rd
        INNER JOIN ${CH_DB}.public_ledger_transactions AS lt FINAL
          ON lt.user_id = rd.referred_user_id
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          ${periodClause}
        GROUP BY rd.creator_id
      ),
      creator_cost AS (
        SELECT
          lt.user_id AS creator_id,
          sum(if(
            lt.type IN ('affiliate_claim','creator_tip','admin_balance_adjustment')
              AND NOT (lt.type = 'admin_balance_adjustment'
                       AND JSONExtractString(ifNull(lt.metadata, ''), 'adjustment_category') = '${OFFICIAL_STREAM_CATEGORY}'),
            greatest(lt.balance_after - lt.balance_before, toDecimal128(0, 2)),
            toDecimal128(0, 2)
          )) AS cost
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.user_id IN (SELECT user_id FROM creators)
          ${periodClause}
        GROUP BY lt.user_id
      )
    SELECT
      c.user_id AS user_id,
      c.username AS username,
      c.affiliate_code AS affiliate_code,
      toString(ifNull(rc.cnt, 0)) AS referred_users,
      toString(ifNull(rl.wagers, toDecimal128(0, 2)) - ifNull(rl.payouts, toDecimal128(0, 2))) AS gross_platform_pnl,
      toString(ifNull(cc.cost, toDecimal128(0, 2))) AS creator_cost
    FROM creators c
    LEFT JOIN ref_counts rc ON rc.creator_id = c.user_id
    LEFT JOIN referred_ledger rl ON rl.creator_id = c.user_id
    LEFT JOIN creator_cost cc ON cc.creator_id = c.user_id
    SETTINGS join_use_nulls = 1`;

  const rows = await clickhouseRead.query<LtvSqlRow>({
    queryName: "analytics.ltv.creators",
    sql,
    params,
  });

  const mapped: CreatorLtvRowCh[] = rows.map((r) => {
    const gross = toNumber(r.gross_platform_pnl ?? "0");
    const cost = toNumber(r.creator_cost ?? "0");
    const net = gross - cost;
    const multiple = cost > 0 ? gross / cost : null;
    return {
      userId: r.user_id,
      username: r.username,
      code: r.affiliate_code,
      referredUsers: Number(r.referred_users ?? "0"),
      grossPlatformPnl: gross,
      creatorCost: cost,
      netRoi: net,
      roiMultiple: multiple,
    };
  });

  mapped.sort((a, b) => b.netRoi - a.netRoi);

  const totals = mapped.reduce(
    (acc, r) => {
      acc.grossPlatformPnl += r.grossPlatformPnl;
      acc.creatorCost += r.creatorCost;
      acc.netRoi += r.netRoi;
      if (r.netRoi > 0) acc.profitableCreators += 1;
      else if (r.netRoi < 0) acc.losingCreators += 1;
      return acc;
    },
    {
      grossPlatformPnl: 0,
      creatorCost: 0,
      netRoi: 0,
      profitableCreators: 0,
      losingCreators: 0,
    },
  );

  return { period, rows: mapped, totals };
}
