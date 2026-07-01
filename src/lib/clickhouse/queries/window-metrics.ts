import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  ggrWindowToMetricWindow,
  GGR_LIFETIME_LOOKBACK_DAYS,
} from "@/lib/metrics/ggr-window";
import {
  type MetricWindow,
  type WindowMetrics,
  type DailyGamingMetricPoint,
} from "@/lib/metrics/queries";
import {
  WAGER_TYPES,
  GAMING_PAYOUT_TYPES,
  REWARD_PAYOUT_TYPES,
  ledgerTypesToSqlList,
} from "@/lib/metrics/ledger-sets";
import {
  ggr as ggrFormula,
  ngr as ngrFormula,
  gamingPayoutTotal,
  resolveRainHouseCost,
  empiricalRtp,
  empiricalHouseEdge,
  type RainHouseCost,
} from "@/lib/metrics/formulas";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Phase 2A — Platform window-metrics (headline GGR / NGR / wager / payout /
 * RTP / house-edge), read from the ClickHouse prod game mirror (`packy_prod`,
 * PeerDB CDC). This is the ClickHouse twin of the canonical Postgres
 * `getWindowMetrics` / `getDailyGamingMetrics` in `@/lib/metrics/queries`.
 *
 * PARITY with the canonical Postgres definition (`@/lib/metrics`):
 *
 *   wager        = Σ ABS(ledger.amount) over WAGER_TYPES
 *                  (pack_opening / battle_bet / battle_sponsorship), with the
 *                  WAGER_LEG_FILTER reward/daily-pack exclusion on pack_opening
 *                  (battle_bet + battle_sponsorship counted unconditionally —
 *                  borrow-net-INCLUSIVE basis, owner decision 2026-06-13).
 *
 *   gamingPayout = Σ user_inventory.value_at_obtained (source_type IN
 *                  ('pack','battle'), by obtained_at), with reward-pack won
 *                  cards excluded via source_id ∉ reward-pack sessions
 *                + Σ ABS(ledger.amount) over GAMING_PAYOUT_TYPES
 *                  (battle_refund + battle_excess_to_voucher)
 *                + Σ upgrader_games.won_amount (real gameplay, off-ledger).
 *
 *   rewardCost   = Σ ABS(ledger.amount) over REWARD_PAYOUT_TYPES EXCLUDING
 *                  rain_win
 *                + the manual-voucher carve-out (voucher_redeemed with
 *                  metadata.origin = 'manual')
 *                + the counted-adjustment carve-out (admin_balance_adjustment
 *                  credits carrying a COUNTED adjustment_category).
 *
 *   ggr = wager − gamingPayout
 *   ngr = ggr − rewardCostExclRain − rainHouseCost
 *         where rainHouseCost = max(0, Σ|rain_win| − Σ|rain_tip|) (net rain
 *         model, owner-confirmed default).
 *
 * Upgrader is FOLDED IN (same as the PG twin): its bet_amount joins wager and
 * won_amount joins the payout side, so headline GGR = pack + battle + upgrader.
 *
 * TODO(dd): Double Down is NOT folded in here — the source table
 * `battle_double_down_offers` is not yet mirrored to ClickHouse
 * (`packy_prod.public_battle_double_down_offers` does not exist). The PG
 * twin (`getGamingLegs` / `getWindowMetrics.pgRead`) folds DD via
 * `doubleDownLegs` — wager = Σ `won_amount_usd` over resolved rounds,
 * payout = Σ paired voucher `value` on wins. Until DD lands in the CH
 * mirror this twin will UNDER-count GGR by the DD contribution (small
 * today — the feature is a few days old with tiny volume — but the drift
 * grows as DD picks up). Documented gap; when DD is mirrored: add a
 * `public_battle_double_down_offers` FINAL leg here mirroring the PG one
 * (wager Σ `won_amount_usd` on `result IS NOT NULL`, payout Σ v.value on
 * `result='win'` joined by `won_voucher_id` to `public_vouchers` with
 * `origin='battle_double_down_payout'`), bucketed by `resolved_at`.
 *
 * SESSION-WINDOW CTE OMITTED (contract g): the PG twin uses
 * `getMetricsScope()` — a session-window predicate that KEEPS creators but
 * drops their on-session rows per-row. This ClickHouse module instead uses a
 * wholesale `role NOT IN ('admin','support','creator')` `real_users` CTE
 * (creators dropped entirely by role), exactly like `dashboard-cashflow.ts`.
 * Because creators are already excluded wholesale, the creator session-window
 * carve-out has nothing left to exclude, so it is dropped. The comparison
 * mode validates this matches Postgres for these surfaces. See `parityNotes`
 * in the module's structured report for the exact reasoning and risk.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* mirror table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0` everywhere.
 *   • Money stays Decimal end-to-end: toString(sum(...)) in SQL, toNumber()
 *     in TS — never Float / toFloat — so parity is exact to the cent.
 *
 * The blacklist is passed IN by the caller (fetched from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres client — it is a
 * pure ClickHouse read. The window cutoff reuses the SAME canonical helpers the
 * Postgres path uses (`ggrWindowToMetricWindow` → `periodToCutoff` /
 * `GGR_LIFETIME_LOOKBACK_DAYS`), guaranteeing an identical window.
 */

const CH_DB = "packy_prod";

/** JS Date (UTC) → ClickHouse DateTime64 literal 'YYYY-MM-DD HH:MM:SS.fff'. */
function chDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * The `real_users` CTE — wholesale customer scope (creators dropped by role),
 * mirroring `dashboard-cashflow.ts`. The session-window creator carve-out is
 * intentionally OMITTED (see the module header / parityNotes): creators are
 * already excluded here, so there is nothing left for it to exclude.
 */
function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/**
 * The reward/daily-pack session set — `game_sessions` for reward-pack opens
 * (`game_type='pack'` → `packs.pack_type='reward'`). Mirrors
 * `@/lib/metrics/gaming-sql` `REWARD_PACK_SESSIONS`. Used to drop the $0-wager
 * giveaway opens from BOTH the wager leg (game_session_id) and the won-card
 * inventory leg (source_id). FINAL + `_peerdb_is_deleted = 0` on both mirror
 * tables.
 */
function rewardPackSessionsSubquery(): string {
  return `(
        SELECT gs.id
        FROM ${CH_DB}.public_game_sessions AS gs FINAL
        INNER JOIN ${CH_DB}.public_packs AS p FINAL
          ON p.id = gs.game_id AND p._peerdb_is_deleted = 0 AND p.pack_type = 'reward'
        WHERE gs._peerdb_is_deleted = 0
          AND gs.game_type = 'pack'
      )`;
}

// SQL list literals from the canonical ledger-type sets (pure constants —
// injection-free by construction, same as the Postgres path).
const WAGER_TYPES_SQL = ledgerTypesToSqlList(WAGER_TYPES);
const GAMING_PAYOUT_TYPES_SQL = ledgerTypesToSqlList(GAMING_PAYOUT_TYPES);
const REWARD_PAYOUT_TYPES_SQL = ledgerTypesToSqlList(REWARD_PAYOUT_TYPES);
// COUNTED adjustment-category keys, inlined as raw strings so the ClickHouse
// read graph never imports `@/lib/balance-adjustment-categories` (which pulls
// the engine-free `@/generated/prisma/browser` sentinel) — keeping the CQRS
// boundary free of ANY Prisma reach, directly or transitively. These are the
// CREDIT categories EXCEPT `other`, `official_stream`, and the removal-only
// debits (`leaderboard`/`remove_locked_balance`/`fraud_abuse`). Canonical
// source of truth: `COUNTED_ADJUSTMENT_CATEGORY_KEYS` in
// `@/lib/balance-adjustment-categories` — keep this list in sync (same pattern
// dashboard-cashflow.ts and the metric layer use to stay client-safe).
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

/**
 * ClickHouse predicate for the canonical WAGER leg, AND'd into a
 * `type IN WAGER_TYPES` ledger query — the CH twin of `WAGER_LEG_FILTER`.
 * Borrow-net-INCLUSIVE: pack_opening counted unless a reward/daily pack;
 * battle_bet + battle_sponsorship counted directly. The
 * `game_session_id IS NULL OR …` guard keeps NULL-session pack opens counted.
 */
function wagerLegFilterCh(rewardPackSessions: string): string {
  return `(
        type NOT IN ('pack_opening','battle_bet','battle_sponsorship')
        OR (type = 'pack_opening'
            AND (game_session_id IS NULL OR game_session_id NOT IN ${rewardPackSessions}))
        OR type = 'battle_bet'
        OR type = 'battle_sponsorship'
      )`;
}

/**
 * ClickHouse predicate for the canonical INVENTORY-PAYOUT leg, AND'd into a
 * `source_type IN ('pack','battle')` user_inventory query — the CH twin of
 * `PAYOUT_LEG_FILTER`. Borrow-net-inclusive: all pack/battle won cards kept,
 * only reward/daily-pack won cards excluded (keyed on source_id).
 */
function payoutLegFilterCh(rewardPackSessions: string): string {
  return `(
        source_type IN ('pack','battle')
      ) AND (source_id IS NULL OR source_id NOT IN ${rewardPackSessions})`;
}

/**
 * The manual-voucher carve-out predicate (CH): a `voucher_redeemed` row whose
 * `metadata.origin = 'manual'` is an admin house-granted voucher whose only
 * ledger touchpoint is the redemption → REWARD cost. Mirrors the PG
 * `type = 'voucher_redeemed' AND metadata->>'origin' = 'manual'` branch.
 *
 * `JSONExtractString(metadata, 'origin')` is the CH analogue of Postgres
 * `metadata->>'origin'` (returns '' for a missing/non-string key, so a row
 * without the key never matches — same as the PG `= 'manual'` comparison).
 */
const MANUAL_VOUCHER_PREDICATE_CH =
  `(type = 'voucher_redeemed' AND JSONExtractString(metadata, 'origin') = 'manual')`;

/**
 * The counted-adjustment carve-out predicate (CH): an
 * `admin_balance_adjustment` CREDIT (amount > 0) carrying a COUNTED
 * `adjustment_category` is a house-funded promo cost → REWARD cost. Mirrors
 * `countedAdjustmentSqlPredicate()` (type + amount>0 + category IN counted).
 */
const COUNTED_ADJ_PREDICATE_CH = `(type = 'admin_balance_adjustment' AND amount > 0 AND JSONExtractString(metadata, 'adjustment_category') IN ${COUNTED_ADJ_CATEGORIES_SQL})`;
// NOTE: the `amount > 0` sign check is a CREDIT/DEBIT direction guard only (it
// gates WHICH rows are counted, never the summed money — the money stays in the
// Decimal `toString(sum(abs(amount)))` below, never compared as Float). The PG
// twin uses `amount::numeric > 0`. `amount > 0` on the CH Decimal column is an
// exact Decimal comparison.

type WindowRow = {
  wager: string;
  ledger_gaming_payout: string;
  reward_excl_rain: string;
  rain_win: string;
  rain_tip: string;
  bets: string;
};
type InvRow = { inv_payout: string };
type UpgRow = { upg_wager: string; upg_payout: string; upg_bets: string };

/**
 * Build the shared SQL fragments for a window. `since` null = lifetime
 * (no lower bound); otherwise `AND <col> >= {cutoff:DateTime64(6)}`.
 */
function buildFragments(hasBlacklist: boolean, since: Date | null) {
  const rewardPackSessions = rewardPackSessionsSubquery();
  const sinceLedger = since === null ? "" : "AND lt.created_at >= {cutoff:DateTime64(6)}";
  const sinceInv = since === null ? "" : "AND ui.obtained_at >= {cutoff:DateTime64(6)}";
  const sinceUpg = since === null ? "" : "AND ug.created_at >= {cutoff:DateTime64(6)}";
  return {
    realUsers: realUsersCte(hasBlacklist),
    rewardPackSessions,
    wagerLegFilter: wagerLegFilterCh(rewardPackSessions),
    payoutLegFilter: payoutLegFilterCh(rewardPackSessions),
    sinceLedger,
    sinceInv,
    sinceUpg,
  };
}

/**
 * ClickHouse twin of `getWindowMetrics` (`@/lib/metrics/queries`). Returns the
 * SAME `WindowMetrics` shape. Three parallel reads — ledger (wager + ledger
 * gaming-payout + reward legs + bets), inventory payout, and upgrader — then
 * composed with the PURE `formulas.ts` arithmetic so the GGR/NGR/RTP/edge math
 * is byte-identical to the Postgres path.
 */
export async function getWindowMetricsFromClickHouse(
  metricWindow: MetricWindow,
  blacklist: string[],
): Promise<WindowMetrics> {
  const since = metricWindow.since;
  const hasBlacklist = blacklist.length > 0;
  const cutoff = since === null ? undefined : chDateTime(since);
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== undefined) params.cutoff = cutoff;

  const f = buildFragments(hasBlacklist, since);

  // Ledger leg: wager (WAGER_TYPES + WAGER_LEG_FILTER), ledger gaming-payout
  // (GAMING_PAYOUT_TYPES, unconditional within the type filter), reward cost
  // (REWARD_PAYOUT_TYPES excl rain + manual voucher + counted adjustment),
  // rain_win, rain_tip, and the settled-bet count (WAGER_TYPES rows).
  const ledgerSql = `
    WITH ${f.realUsers}
    SELECT
      toString(sum(
        if(lt.type IN ${WAGER_TYPES_SQL} AND ${f.wagerLegFilter}, abs(lt.amount), 0)
      )) AS wager,
      toString(sum(
        if(lt.type IN ${GAMING_PAYOUT_TYPES_SQL}, abs(lt.amount), 0)
      )) AS ledger_gaming_payout,
      toString(sum(
        if(
          (lt.type IN ${REWARD_PAYOUT_TYPES_SQL} AND lt.type != 'rain_win')
          OR ${MANUAL_VOUCHER_PREDICATE_CH}
          OR ${COUNTED_ADJ_PREDICATE_CH},
          abs(lt.amount), 0
        )
      )) AS reward_excl_rain,
      toString(sum(if(lt.type = 'rain_win', abs(lt.amount), 0))) AS rain_win,
      toString(sum(if(lt.type = 'rain_tip', abs(lt.amount), 0))) AS rain_tip,
      toString(sum(if(lt.type IN ${WAGER_TYPES_SQL} AND ${f.wagerLegFilter}, 1, 0))) AS bets
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${f.sinceLedger}`;

  // Inventory payout leg: Σ value_at_obtained, source pack/battle, obtained in
  // window, reward-pack won cards excluded (PAYOUT_LEG_FILTER).
  const invSql = `
    WITH ${f.realUsers}
    SELECT
      toString(sum(ui.value_at_obtained)) AS inv_payout
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ${f.payoutLegFilter}
      AND ui.user_id IN (SELECT id FROM real_users)
      ${f.sinceInv}`;

  // Upgrader leg: Σ bet_amount → wager, Σ won_amount → payout, COUNT → bets.
  // Off-ledger real gameplay (upgrader_games), folded into the headline.
  const upgSql = `
    WITH ${f.realUsers}
    SELECT
      toString(sum(ug.bet_amount)) AS upg_wager,
      toString(sum(ug.won_amount)) AS upg_payout,
      toString(count())            AS upg_bets
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)
      ${f.sinceUpg}`;

  const [ledgerRows, invRows, upgRows] = await Promise.all([
    clickhouseRead.query<WindowRow>({
      queryName: "windowMetrics.ledger",
      sql: ledgerSql,
      params,
    }),
    clickhouseRead.query<InvRow>({
      queryName: "windowMetrics.inventory",
      sql: invSql,
      params,
    }),
    clickhouseRead.query<UpgRow>({
      queryName: "windowMetrics.upgrader",
      sql: upgSql,
      params,
    }),
  ]);

  const lr = ledgerRows[0];
  const ir = invRows[0];
  const ur = upgRows[0];

  const ledgerWager = toNumber(lr?.wager);
  const ledgerGamingPayout = toNumber(lr?.ledger_gaming_payout);
  const rewardCostExclRain = toNumber(lr?.reward_excl_rain);
  const rainWinTotal = toNumber(lr?.rain_win);
  const rainTipTotal = toNumber(lr?.rain_tip);
  const ledgerBets = toNumber(lr?.bets);

  const inventoryPayout = toNumber(ir?.inv_payout);

  const upgraderWager = toNumber(ur?.upg_wager);
  const upgraderPayout = toNumber(ur?.upg_payout);
  const upgraderBets = toNumber(ur?.upg_bets);

  // Fold upgrader into the headline legs (mirrors getGamingLegs).
  const wager = ledgerWager + upgraderWager;
  const bets = ledgerBets + upgraderBets;
  const gamingPayout = gamingPayoutTotal({
    inventoryPayout,
    // battleRefund carries the ledger gaming-payout legs PLUS upgrader payout
    // (same field-name convention as the PG twin's GamingLegs.battleRefund).
    battleRefund: ledgerGamingPayout + upgraderPayout,
  });

  const ggrValue = ggrFormula({ wager, gamingPayout });
  const rainHouseCostInput: RainHouseCost = {
    kind: "net",
    rainWinTotal,
    rainTipTotal,
  };
  const rainHouseCost = resolveRainHouseCost(rainHouseCostInput);
  const ngrValue = ngrFormula({
    ggr: ggrValue,
    rewardCostExclRain,
    rainHouseCost: rainHouseCostInput,
  });

  return {
    wager,
    gamingPayout,
    ggr: ggrValue,
    ngr: ngrValue,
    rtp: empiricalRtp({ gamingPayout, wager, bets }),
    houseEdge: empiricalHouseEdge({ wager, ggr: ggrValue, bets }),
    bets,
    rainWinTotal,
    rainTipTotal,
    rainHouseCost,
  };
}

type LedgerDayRow = {
  date: string;
  wager: string;
  battle_refund: string;
  reward_excl_rain: string;
  rain_win: string;
  rain_tip: string;
};
type InvDayRow = { date: string; inv_payout: string };
type UpgDayRow = { date: string; upg_wager: string; upg_payout: string };

/**
 * ClickHouse twin of `getDailyGamingMetrics` (`@/lib/metrics/queries`).
 * Returns the SAME `DailyGamingMetricPoint[]` per-day series, sharing the EXACT
 * type sets, scope (wholesale-creator-drop; session window omitted — see
 * header), and the pure `ggr`/`ngr` formulas. Buckets:
 *   • wager / reward / rain / ledger gaming-payout legs by created_at UTC date
 *   • inventory payout by obtained_at UTC date
 *   • upgrader wager/payout (upgrader_games) by created_at UTC date
 * then merged per UTC date and floored on rain PER DAY
 * (`max(0, rain_win_day − rain_tip_day)`), identical to the PG twin.
 */
export async function getDailyGamingMetricsFromClickHouse(
  metricWindow: MetricWindow,
  blacklist: string[],
): Promise<DailyGamingMetricPoint[]> {
  const since = metricWindow.since;
  const hasBlacklist = blacklist.length > 0;
  const cutoff = since === null ? undefined : chDateTime(since);
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== undefined) params.cutoff = cutoff;

  const f = buildFragments(hasBlacklist, since);

  // Per-day ledger legs, bucketed by created_at UTC date. toDate on a
  // DateTime64 truncates to the UTC calendar day (mirrors PG DATE(created_at)).
  const ledgerSql = `
    WITH ${f.realUsers}
    SELECT
      toString(toDate(lt.created_at)) AS date,
      toString(sum(
        if(lt.type IN ${WAGER_TYPES_SQL} AND ${f.wagerLegFilter}, abs(lt.amount), 0)
      )) AS wager,
      toString(sum(
        if(lt.type IN ${GAMING_PAYOUT_TYPES_SQL}, abs(lt.amount), 0)
      )) AS battle_refund,
      toString(sum(
        if(
          (lt.type IN ${REWARD_PAYOUT_TYPES_SQL} AND lt.type != 'rain_win')
          OR ${MANUAL_VOUCHER_PREDICATE_CH}
          OR ${COUNTED_ADJ_PREDICATE_CH},
          abs(lt.amount), 0
        )
      )) AS reward_excl_rain,
      toString(sum(if(lt.type = 'rain_win', abs(lt.amount), 0))) AS rain_win,
      toString(sum(if(lt.type = 'rain_tip', abs(lt.amount), 0))) AS rain_tip
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${f.sinceLedger}
    GROUP BY toDate(lt.created_at)`;

  const invSql = `
    WITH ${f.realUsers}
    SELECT
      toString(toDate(ui.obtained_at)) AS date,
      toString(sum(ui.value_at_obtained)) AS inv_payout
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ${f.payoutLegFilter}
      AND ui.user_id IN (SELECT id FROM real_users)
      ${f.sinceInv}
    GROUP BY toDate(ui.obtained_at)`;

  const upgSql = `
    WITH ${f.realUsers}
    SELECT
      toString(toDate(ug.created_at)) AS date,
      toString(sum(ug.bet_amount)) AS upg_wager,
      toString(sum(ug.won_amount)) AS upg_payout
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)
      ${f.sinceUpg}
    GROUP BY toDate(ug.created_at)`;

  const [ledgerRows, invRows, upgRows] = await Promise.all([
    clickhouseRead.query<LedgerDayRow>({
      queryName: "dailyGamingMetrics.ledger",
      sql: ledgerSql,
      params,
    }),
    clickhouseRead.query<InvDayRow>({
      queryName: "dailyGamingMetrics.inventory",
      sql: invSql,
      params,
    }),
    clickhouseRead.query<UpgDayRow>({
      queryName: "dailyGamingMetrics.upgrader",
      sql: upgSql,
      params,
    }),
  ]);

  // Merge the day-keyed sets (union of all key spaces), exactly like the PG
  // twin: a day can appear in ledger-only, inventory-only, or upgrader-only.
  const byDate = new Map<
    string,
    {
      wager: number;
      battleRefund: number;
      inventoryPayout: number;
      rewardCostExclRain: number;
      rainWinTotal: number;
      rainTipTotal: number;
    }
  >();
  const blank = () => ({
    wager: 0,
    battleRefund: 0,
    inventoryPayout: 0,
    rewardCostExclRain: 0,
    rainWinTotal: 0,
    rainTipTotal: 0,
  });
  // CH toDate already yields a 'YYYY-MM-DD' string; slice defensively in case
  // a driver returns a fuller timestamp.
  const dayKey = (d: string) => String(d).slice(0, 10);

  for (const r of ledgerRows) {
    const key = dayKey(r.date);
    const e = byDate.get(key) ?? blank();
    e.wager += toNumber(r.wager);
    e.battleRefund += toNumber(r.battle_refund);
    e.rewardCostExclRain += toNumber(r.reward_excl_rain);
    e.rainWinTotal += toNumber(r.rain_win);
    e.rainTipTotal += toNumber(r.rain_tip);
    byDate.set(key, e);
  }
  for (const r of invRows) {
    const key = dayKey(r.date);
    const e = byDate.get(key) ?? blank();
    e.inventoryPayout += toNumber(r.inv_payout);
    byDate.set(key, e);
  }
  for (const r of upgRows) {
    const key = dayKey(r.date);
    const e = byDate.get(key) ?? blank();
    e.wager += toNumber(r.upg_wager);
    e.battleRefund += toNumber(r.upg_payout);
    byDate.set(key, e);
  }

  return [...byDate.entries()]
    .map(([date, e]) => {
      const gamingPayout = gamingPayoutTotal({
        inventoryPayout: e.inventoryPayout,
        battleRefund: e.battleRefund,
      });
      const ggrValue = ggrFormula({ wager: e.wager, gamingPayout });
      const ngrValue = ngrFormula({
        ggr: ggrValue,
        rewardCostExclRain: e.rewardCostExclRain,
        rainHouseCost: {
          kind: "net",
          rainWinTotal: e.rainWinTotal,
          rainTipTotal: e.rainTipTotal,
        },
      });
      return {
        date,
        wager: e.wager,
        gamingPayout,
        ggr: ggrValue,
        ngr: ngrValue,
        rewardCostExclRain: e.rewardCostExclRain,
        rainWinTotal: e.rainWinTotal,
        rainTipTotal: e.rainTipTotal,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Re-export the canonical window helpers the comparison/cutover wiring will use
// to derive the SAME MetricWindow the Postgres path uses, so a caller never
// re-derives date math (contract b).
export { ggrWindowToMetricWindow, GGR_LIFETIME_LOOKBACK_DAYS };
