import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";

/**
 * Phase 2B — Dashboard "Reward Costs (today)" tile DB-derived lines, read from
 * the ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the DATABASE-DERIVED portion of the canonical Postgres
 * `getRewardCostsToday` (src/lib/queries/dashboard-reward-costs-today.ts), over
 * the SAME window `[since, now)` (today 00:00 UTC — the PG path's
 * `utcStartOfDay`, passed in as `since`; no upper bound, mirroring PG).
 *
 * ─── What this twins (every DB-derived line) ──────────────────────────
 *   • Ledger reward legs (3-role wholesale customer scope + blacklist, same
 *     `getMetricsScope` population; the creator-on-session predicate is a no-op
 *     once creators are dropped wholesale, so it is omitted): deposit_bonus,
 *     rakeback, promo_gift, race, signup_balance, manual_voucher (origin=manual),
 *     counted_adjustments (counted admin_balance_adjustment credits).
 *     Each Σ |amount| over completed rows in the window. `affiliate_claim` is
 *     NOT twinned here — it was MOVED WHOLESALE to the Creators Costs box
 *     (owner, 2026-07-02); see the CH twin at
 *     `clickhouse/queries/dashboard/creator-costs-today.ts`.
 *   • MOTHA — founder account outflows (NO scope): creator_tip +
 *     battle_sponsorship debits + motha-funded rain_tips today.
 *   • RAFFLES — today-window completed raffles' prize JSON reconstructed at LIVE
 *     pack/card prices (§5d: JSONExtractArrayRaw + ARRAY JOIN + join packs/cards
 *     FINAL), winner in the 3-role customer scope. The raffle baseline twin
 *     proved this cent-exact.
 *   • DAILY / FREE PACKS — reward-pack (`packs.pack_type='reward'`) won-card
 *     value (`Σ user_inventory.value_at_obtained`) obtained today, joined through
 *     the originating pack game session (3-role scope; session-window guard is a
 *     redundant no-op under the wholesale creator drop, so omitted).
 *
 * ─── What this DELIBERATELY does NOT twin ─────────────────────────────
 *   • The RAIN line. The PG twin models rain as a flat NON-DB `$2 × hoursElapsed`
 *     (owner-confirmed: "we don't pay anything else for it"), derived from the
 *     live `now`, NOT from any table. It has no DB source to mirror, so it stays
 *     100% Postgres — passed through unchanged at the call site and EXCLUDED from
 *     this comparison. We compare the DB sub-total (PG `total − rainCost`).
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` on every table; money
 * stays Decimal (`toString(sum(...))`/`sumIf` → `toNumber`, never Float); `if()`
 * zero-branches use `toDecimal128(0, 2)` (§5b); category keys / carve-outs are
 * inlined as raw strings so this module imports NO Postgres/Prisma client
 * (keeping the CQRS boundary Prisma-free); the blacklist is passed IN by the caller.
 */

type RewardCostsTodayDbCh = {
  depositBonus: number;
  dailyPacks: number;
  signupBalance: number;
  rakeback: number;
  promoGift: number;
  race: number;
  raffles: number;
  motha: number;
  manualVoucher: number;
  countedAdjustments: number;
  /** Σ of every DB-derived line above (excludes the non-DB rain line). */
  dbTotal: number;
};

const MOTHA_USERNAME = "motha";

/**
 * COUNTED adjustment-category keys — inlined as raw strings (canonical source:
 * `COUNTED_ADJUSTMENT_CATEGORY_KEYS`; every CREDIT category except `other`,
 * `official_stream`, and the removal-only debits). Same list the sibling CH
 * twins inline. Keep in sync.
 */
const COUNTED_ADJ_CATEGORY_KEYS = [
  "deposit_problem",
  "withdrawal_failed",
  "giveaway",
  "bonus",
  "deposit_bonus",
  "bugs",
  "reload",
  "lossback",
] as const;
const COUNTED_ADJ_CATEGORIES_SQL = `(${COUNTED_ADJ_CATEGORY_KEYS.map(
  (k) => `'${k.replace(/'/g, "''")}'`,
).join(",")})`;

type LedgerRow = {
  deposit_bonus: string;
  rakeback: string;
  promo_gift: string;
  race: string;
  signup_balance: string;
  manual_voucher: string;
  counted_adjustments: string;
};
type MothaLedgerRow = { motha_ledger: string };
type MothaRainRow = { motha_rain: string };
type RaffleRow = { cost: string };
type PackRow = { giveaway_payout: string };

export async function getRewardCostsTodayDbFromClickHouse(
  since: Date,
  blacklist: string[],
): Promise<RewardCostsTodayDbCh> {
  const cutoff = chDateTime(since);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };
  const scope = customerScopeCte({ hasBlacklist });

  // ── Ledger reward legs (3-role wholesale scope + blacklist, completed, today) ──
  const ledgerSql = `
    WITH ${scope}
    SELECT
      toString(sumIf(abs(lt.amount), lt.type = 'deposit_bonus'))                                    AS deposit_bonus,
      toString(sumIf(abs(lt.amount), lt.type = 'rakeback_claim'))                                   AS rakeback,
      toString(sumIf(abs(lt.amount), lt.type IN ('gift_card_redeemed','promo_code_redeemed')))      AS promo_gift,
      toString(sumIf(abs(lt.amount), lt.type = 'race_prize'))                                       AS race,
      toString(sumIf(abs(lt.amount), lt.type IN ('balance_reward_claim','waitlist_prize')))         AS signup_balance,
      toString(sumIf(abs(lt.amount), lt.type = 'voucher_redeemed' AND JSONExtractString(lt.metadata, 'origin') = 'manual')) AS manual_voucher,
      toString(sumIf(abs(lt.amount), lt.type = 'admin_balance_adjustment' AND lt.amount > 0 AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${COUNTED_ADJ_CATEGORIES_SQL})) AS counted_adjustments
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}`;

  // ── Daily / free-pack giveaway — reward-pack won cards obtained today ──
  const dailyPacksSql = `
    WITH ${scope},
    reward_cards AS (
      SELECT ui.value_at_obtained AS card_value
      FROM ${CH_DB}.public_user_inventory AS ui FINAL
      INNER JOIN ${CH_DB}.public_game_sessions AS gs FINAL
        ON gs.id = ui.source_id AND gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
      INNER JOIN ${CH_DB}.public_packs AS p FINAL
        ON p.id = gs.game_id AND p._peerdb_is_deleted = 0 AND p.pack_type = 'reward'
      WHERE ui._peerdb_is_deleted = 0
        AND ui.user_id IN (SELECT id FROM real_users)
        AND ui.obtained_at >= {cutoff:DateTime64(6)}
    )
    SELECT toString(sum(card_value)) AS giveaway_payout
    FROM reward_cards`;

  // ── Raffles — completed-today raffle prizes valued at LIVE pack/card price ──
  const raffleSql = `
    WITH ${scope},
    in_scope AS (
      SELECT r.id AS raffle_id
      FROM ${CH_DB}.public_raffles AS r FINAL
      WHERE r._peerdb_is_deleted = 0
        AND r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND r.completed_at >= {cutoff:DateTime64(6)}
        AND r.winner_user_id IN (SELECT id FROM real_users)
    )
    SELECT toString(sum(qty * price)) AS cost
    FROM (
      SELECT
        multiIf(JSONExtractInt(line, 'quantity') > 0, JSONExtractInt(line, 'quantity'), 1) AS qty,
        ifNull(
          if(JSONExtractString(line, 'type') = 'pack', pk.price, cd.price),
          toDecimal128(0, 2)
        ) AS price
      FROM ${CH_DB}.public_raffles AS r FINAL
      ARRAY JOIN JSONExtractArrayRaw(r.prizes) AS line
      LEFT JOIN (
        SELECT toString(id) AS id, price
        FROM ${CH_DB}.public_packs FINAL
        WHERE _peerdb_is_deleted = 0
      ) AS pk ON JSONExtractString(line, 'type') = 'pack' AND pk.id = JSONExtractString(line, 'id')
      LEFT JOIN (
        SELECT toString(id) AS id, price
        FROM ${CH_DB}.public_cards FINAL
        WHERE _peerdb_is_deleted = 0
      ) AS cd ON JSONExtractString(line, 'type') = 'card' AND cd.id = JSONExtractString(line, 'id')
      WHERE r._peerdb_is_deleted = 0
        AND r.id IN (SELECT raffle_id FROM in_scope)
        AND JSONExtractString(line, 'type') IN ('pack', 'card')
        AND JSONExtractString(line, 'id') != ''
    )`;

  // Resolve motha's id once (case-insensitive). No account → 0, matching PG.
  const mothaIdRowsPromise = clickhouseRead.query<{ id: string }>({
    queryName: "dashboard.rewardCostsToday.mothaId",
    sql: `
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND lower(username) = {username:String}
      LIMIT 1`,
    params: { username: MOTHA_USERNAME },
  });

  const [ledgerRows, packRows, raffleRows, mothaIdRows] = await Promise.all([
    clickhouseRead.query<LedgerRow>({
      queryName: "dashboard.rewardCostsToday.ledger",
      sql: ledgerSql,
      params,
    }),
    clickhouseRead.query<PackRow>({
      queryName: "dashboard.rewardCostsToday.dailyPacks",
      sql: dailyPacksSql,
      params,
    }),
    clickhouseRead.query<RaffleRow>({
      queryName: "dashboard.rewardCostsToday.raffles",
      sql: raffleSql,
      params,
    }),
    mothaIdRowsPromise,
  ]);

  // ── Motha giveaways today (founder account outflows; NO scope) ──
  let motha = 0;
  const mothaId = mothaIdRows[0]?.id ?? null;
  if (mothaId != null) {
    const mothaParams = { mothaId, cutoff };
    const [mothaLedger, mothaRain] = await Promise.all([
      clickhouseRead.query<MothaLedgerRow>({
        queryName: "dashboard.rewardCostsToday.mothaLedger",
        sql: `
          SELECT toString(sum(abs(lt.amount))) AS motha_ledger
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.user_id = {mothaId:String}
            AND lt.type IN ('creator_tip','battle_sponsorship')
            AND lt.created_at >= {cutoff:DateTime64(6)}`,
        params: mothaParams,
      }),
      clickhouseRead.query<MothaRainRow>({
        queryName: "dashboard.rewardCostsToday.mothaRain",
        sql: `
          SELECT toString(sum(abs(rt.amount_usd))) AS motha_rain
          FROM ${CH_DB}.public_rain_tips AS rt FINAL
          WHERE rt._peerdb_is_deleted = 0
            AND rt.user_id = {mothaId:String}
            AND rt.created_at >= {cutoff:DateTime64(6)}`,
        params: mothaParams,
      }),
    ]);
    motha =
      toNumber(mothaLedger[0]?.motha_ledger) + toNumber(mothaRain[0]?.motha_rain);
  }

  const lr = ledgerRows[0];
  const depositBonus = toNumber(lr?.deposit_bonus);
  const rakeback = toNumber(lr?.rakeback);
  const promoGift = toNumber(lr?.promo_gift);
  const race = toNumber(lr?.race);
  const signupBalance = toNumber(lr?.signup_balance);
  const manualVoucher = toNumber(lr?.manual_voucher);
  const countedAdjustments = toNumber(lr?.counted_adjustments);
  const dailyPacks = toNumber(packRows[0]?.giveaway_payout);
  const raffles = toNumber(raffleRows[0]?.cost);

  const dbTotal =
    depositBonus +
    dailyPacks +
    signupBalance +
    rakeback +
    promoGift +
    race +
    raffles +
    motha +
    manualVoucher +
    countedAdjustments;

  return {
    depositBonus,
    dailyPacks,
    signupBalance,
    rakeback,
    promoGift,
    race,
    raffles,
    motha,
    manualVoucher,
    countedAdjustments,
    dbTotal,
  };
}
