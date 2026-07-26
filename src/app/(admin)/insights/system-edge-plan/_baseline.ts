import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";

import { toNumber } from "@/lib/utils/decimal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getWindowMetrics,
  sumLedgerTypes,
  upgraderMetrics,
  type MetricWindow,
} from "@/lib/metrics/queries";
import { getMetricsScope } from "@/lib/metrics/scope";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
import { empiricalHouseEdge } from "@/lib/metrics/formulas";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators-analytics";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import { getDailyPacksGiveaway } from "@/lib/queries/insights-rewards/daily-packs";
import { getSignupOverview } from "@/lib/queries/insights-rewards/signup/overview";
import { getRaffleForecastBaseline } from "@/lib/queries/insights-rewards/raffle/overview";
import { getMothaGiveawayOverview } from "@/lib/queries/insights-rewards/motha/overview";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import type {
  AffiliateTierLever,
  DailyPackLeverRow,
  GameTypeBaseline,
  PackCardPreview,
  PackVisualFields,
  RakebackCadenceId,
  RakebackCadenceLever,
  RewardPackCatalogItem,
  SystemEdgeBaseline,
  WelcomePackInfo,
} from "./_model";

/**
 * _baseline.ts — assemble the REAL, serializable System Edge Plan baseline
 * (read-only, at request time).
 *
 * EVERYTHING here is real production data — NEVER invented (a prior agent
 * fabricated a "5% rakeback"; the rates below come straight from the live
 * `rakeback_config` / `affiliate_level_configs` tables and the canonical metric
 * layer):
 *
 *   • per-type wager / gaming payout / empirical edge / bets
 *       ← a per-type split of the canonical gaming legs (packs vs battles vs
 *         upgrader), built here with the EXACT canonical scope + borrow/reward
 *         filters (`getMetricsScope`, `WAGER_LEG_FILTER`, `PAYOUT_LEG_FILTER`)
 *         that `getGamingLegs` uses, so the three types sum to the canonical
 *         headline GGR by construction. Upgrader is sourced from
 *         `upgraderMetrics` (to_regclass-guarded → 0 / not-wired on a
 *         pre-upgrader DB).
 *   • headline wager / GGR / edge ← `getWindowMetrics` (canonical scope) — used
 *       to cross-check the per-type split + seed the blended edge.
 *   • per-lever realized reward cost (rakeback / affiliate / deposit bonus /
 *     race) ← `sumLedgerTypes` over the real ledger type(s) for each lever,
 *       under the SAME canonical scope, so the lever costs reconcile with NGR.
 *       `race` here is strictly the `race_prize` ledger type (on-site
 *       competitive RACES), NOT raffles.
 *   • raffle prize cost ← `getRaffleForecastBaseline().totalPrizeCost`. Raffles
 *       are a DISTINCT reward (ticket raffles); they pay out pack/card ITEMS via
 *       a `prizes` JSON (no ledger money leg), so the cost is RECONSTRUCTED by
 *       valuing each completed raffle's prizes at the live pack/card price. As a
 *       NON-ledger cost it is NOT inside the canonical NGR reward cost — it is
 *       added on top as its own lever (exactly like daily packs), so it never
 *       double-counts with the `race_prize` line.
 *   • daily-pack giveaway cost ← `getDailyPacksTotalCost` (Σ card value out).
 *   • signup balance-reward cost + avg grant ← `getSignupOverview`.
 *   • net rain cost ← `getWindowMetrics().rainHouseCost` (owner-confirmed
 *       `max(0, rain_win − rain_tip)`).
 *   • motha (founder giveaway account) outflow ←
 *       `getMothaGiveawayOverview().totalCost` (creator_tip +
 *       battle_sponsorship + rain_tips funded by motha). Canonically the
 *       rows are RESIDUAL / WAGER / rain-funding (not in `getRewardCost`),
 *       so adding the line on top cannot double-count with the canonical
 *       reward cost — exactly the same shape as raffles + daily packs.
 *   • rakeback per-cadence rates ← `getRakebackConfigs()` → `rakeback_config`.
 *   • affiliate per-tier rates + thresholds ← `getAffiliateLevelConfigs()` →
 *       `affiliate_level_configs`.
 *   • blended affiliate rate + referred-wager anchor ← `getAffiliateOverview`.
 *
 * Active-timeframe-only (CLAUDE.md): the page mounts ONE baseline per `?period=`
 * inside a keyed `<Suspense>`, so only the selected window is fetched. Heavy
 * reads are wrapped in `unstable_cache` keyed on the period (60s / 300s).
 *
 * RESILIENCE (CRITICAL — the page must NEVER collapse to the insights error
 * boundary because ONE aggregate fails): EVERY query below is wrapped
 * INDIVIDUALLY in `safeQuery` with (a) a sensible LABELED fallback and (b) an
 * explicit `REWARD_QUERY_TIMEOUT_MS` budget. `safeQuery` catches a THROW (stale
 * column, JSON parse, NaN, missing table) AND — via the timeout — a merely SLOW
 * query (an unbounded scan on a larger prod dataset), so either failure mode
 * degrades ONLY that lever to its fallback (the lever renders as
 * data-unavailable / estimated) while every other lever and the whole page
 * still render. There is no un-guarded DB await on this path: the only awaits
 * are inside `getPackBattleLegs` (itself wrapped) and the two `Promise.all`s
 * whose every element is a `safeQuery`. Lifetime is bounded via
 * `daysForInsightsPeriodCapped` (no unbounded scans).
 */

/** The non-tunable reward legs NOT exposed as their own lever in the planner. */
const RAKEBACK_TYPES = ["rakeback_claim"] as const;
const AFFILIATE_TYPES = [
  "affiliate_claim",
  "affiliate_leaderboard_prize",
] as const;
const DEPOSIT_BONUS_TYPES = ["deposit_bonus"] as const;
const RACE_TYPES = ["race_prize"] as const;

/**
 * Backend-enforced deposit-bonus baseline reference (per the discovery — these
 * live in the GAME backend, not this admin). Surfaced as the lever's reference
 * point; the lever models the proportional cost effect of changing the cap /
 * window, it does NOT write them.
 */
const DEPOSIT_BONUS_BASELINE_CAP_USD = 100;
const DEPOSIT_BONUS_BASELINE_WINDOW_HOURS = 24;

/** Map an InsightsRewardsPeriod onto a canonical `MetricWindow` (lifetime bounded). */
function windowFor(period: InsightsRewardsPeriod): MetricWindow {
  // Bound lifetime so the canonical scans don't go full-history (CLAUDE.md
  // "Active-Timeframe-Only" — lifetime windows must be capped). Finite windows
  // resolve to their day count directly.
  const days = daysForInsightsPeriodCapped(period);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function normalizeCadence(type: string): RakebackCadenceId | null {
  if (type === "daily" || type === "weekly" || type === "monthly") return type;
  return null;
}

/** Inline `AND created_at >= <since>` clause (since is always set by windowFor). */
function sinceClause(column: string, since: Date | null): string {
  if (since === null) return "";
  return `AND ${column} >= '${since.toISOString()}'::timestamptz`;
}

/**
 * Per-type pack/battle gaming legs — the per-type split of the canonical
 * `getGamingLegs` ledger + inventory reads.
 *
 * This mirrors `getGamingLegs` EXACTLY (same canonical session-window scope,
 * same `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` borrow + reward-pack
 * exclusions) but partitions the sums by game type:
 *   • WAGER:  pack_opening → packs · battle_bet + battle_sponsorship → battles
 *   • PAYOUT: user_inventory.source_type='pack' → packs · 'battle' → battles
 *
 * So packs.wager + battles.wager = the canonical ledger wager (excl. upgrader),
 * and packs.payout + battles.payout = the canonical inventory + battle-refund
 * payout — i.e. the two types reconcile with the headline by construction.
 * Upgrader is added separately by the caller from `upgraderMetrics`.
 */
type PackBattleLegs = {
  packsWager: number;
  battlesWager: number;
  packsBets: number;
  battlesBets: number;
  packsInvPayout: number;
  battlesInvPayout: number;
  /** Ledger cash gaming payout (battle_refund + battle_excess_to_voucher) — all battles. */
  battlesLedgerPayout: number;
};

async function getPackBattleLegs(window: MetricWindow): Promise<PackBattleLegs> {
  const scope = await getMetricsScope();
  const since = window.since;

  type WagerRow = {
    packs_wager: string;
    battles_wager: string;
    packs_bets: string;
    battles_bets: string;
  };
  type InvRow = { packs_inv: string; battles_inv: string };
  type LedgerPayoutRow = { battle_refund: string };

  const [wagerRows, invRows, ledgerPayoutRows] = await Promise.all([
    queryMainRows<WagerRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS packs_wager,
         COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battles_wager,
         COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN 1 ELSE 0 END), 0)::text AS packs_bets,
         COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN 1 ELSE 0 END), 0)::text AS battles_bets
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text IN ${WAGER_TYPES_SQL}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", since)}
         AND ${WAGER_LEG_FILTER}`,
    ),
    queryMainRows<InvRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE WHEN source_type = 'pack' THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS packs_inv,
         COALESCE(SUM(CASE WHEN source_type = 'battle' THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battles_inv
       FROM user_inventory
       WHERE source_type IN ('pack','battle')
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "obtained_at")}
         ${sinceClause("obtained_at", since)}
         AND ${PAYOUT_LEG_FILTER}`,
    ),
    queryMainRows<LedgerPayoutRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(ABS(amount::numeric)), 0)::text AS battle_refund
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text IN ${GAMING_PAYOUT_TYPES_SQL}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", since)}`,
    ),
  ]);

  return {
    packsWager: toNumber(wagerRows[0]?.packs_wager),
    battlesWager: toNumber(wagerRows[0]?.battles_wager),
    packsBets: toNumber(wagerRows[0]?.packs_bets),
    battlesBets: toNumber(wagerRows[0]?.battles_bets),
    packsInvPayout: toNumber(invRows[0]?.packs_inv),
    battlesInvPayout: toNumber(invRows[0]?.battles_inv),
    battlesLedgerPayout: toNumber(ledgerPayoutRows[0]?.battle_refund),
  };
}

/**
 * Build the per-type gaming baseline (packs / battles / upgrader). The
 * battle_refund + battle_excess_to_voucher ledger payout legs are attributed to
 * BATTLES (they are battle-win settlement legs), so packs.payout is purely the
 * pack inventory delta. The three types' wager + payout sum to the canonical
 * `getGamingLegs` totals.
 */
function buildGameTypes(
  legs: PackBattleLegs,
  upg: { wager: number; payout: number; bets: number } | null,
): GameTypeBaseline[] {
  const packsPayout = legs.packsInvPayout;
  const battlesPayout = legs.battlesInvPayout + legs.battlesLedgerPayout;

  const packs: GameTypeBaseline = {
    type: "packs",
    wager: legs.packsWager,
    payout: packsPayout,
    ggr: legs.packsWager - packsPayout,
    edge: empiricalHouseEdge({
      wager: legs.packsWager,
      ggr: legs.packsWager - packsPayout,
      bets: legs.packsBets,
    }),
    bets: legs.packsBets,
    dataAvailable: legs.packsWager > 0,
  };
  const battles: GameTypeBaseline = {
    type: "battles",
    wager: legs.battlesWager,
    payout: battlesPayout,
    ggr: legs.battlesWager - battlesPayout,
    edge: empiricalHouseEdge({
      wager: legs.battlesWager,
      ggr: legs.battlesWager - battlesPayout,
      bets: legs.battlesBets,
    }),
    bets: legs.battlesBets,
    dataAvailable: legs.battlesWager > 0,
  };
  const upgrader: GameTypeBaseline = {
    type: "upgrader",
    wager: upg?.wager ?? 0,
    payout: upg?.payout ?? 0,
    ggr: (upg?.wager ?? 0) - (upg?.payout ?? 0),
    edge:
      upg != null
        ? empiricalHouseEdge({
            wager: upg.wager,
            ggr: upg.wager - upg.payout,
            bets: upg.bets,
          })
        : null,
    bets: upg?.bets ?? 0,
    // Upgrader figures only come from `upgrader_games`; null = no table on this
    // DB (pre-upgrader snapshot) → surface the lever but label it not-wired.
    dataAvailable: upg != null,
  };

  return [packs, battles, upgrader];
}

/**
 * Read the WELCOME / one-time reward packs + their THEORETICAL EVs (read-only).
 *
 * The admin code does not enumerate welcome packs anywhere, so this is a new
 * read-only query (MAIN prod, SELECT only — permitted): take `rewards` rows of
 * `type = 'one_time'` whose `pack_ids` reference a `pack_type = 'reward'` pack,
 * and compute each referenced pack's EV per open the SAME way `getPackDetail`
 * does — `cards_per_open × Σ (weight / Σweight × cards.price)` over
 * `pack_cards` joined to `cards`.
 *
 * DISPLAY-ONLY context (the signup COST is the cash `balance_reward_claim`
 * lever, not these EVs). One row per (reward, referenced reward-pack) pair.
 * Period-agnostic (the reward catalog doesn't change with the window). Returns
 * `[]` when no `one_time` reward references a reward pack — the UI then reports
 * the ambiguity rather than fabricating a welcome set.
 */
async function getWelcomePacks(): Promise<WelcomePackInfo[]> {
  type Row = {
    reward_slug: string;
    reward_name: string;
    pack_id: string;
    pack_name: string;
    pack_slug: string;
    cards_per_open: number;
    ev_per_open: string;
  };
  // `r.pack_ids` is a uuid[]; unnest it, join to reward packs only, and value
  // each pack's card pool at the live `cards.price`. EV per open uses the pack's
  // own card pool (weight-share × price) × cards_per_open — identical math to
  // `getPackDetail`'s probability/value computation, expressed in one pass.
  const rows = await queryMainRows<Row[]>(
    `WITH one_time_packs AS (
       SELECT r.slug AS reward_slug, r.name AS reward_name, pid AS pack_id
       FROM rewards r
       CROSS JOIN LATERAL unnest(r.pack_ids) AS pid
       WHERE r.type::text = 'one_time'
     )
     SELECT
       otp.reward_slug,
       otp.reward_name,
       p.id::text AS pack_id,
       p.name AS pack_name,
       p.slug AS pack_slug,
       p.cards_per_open AS cards_per_open,
       COALESCE(
         (
           SELECT (SUM(pc.weight::numeric * c.price::numeric) / NULLIF(SUM(pc.weight::numeric), 0))
                  * p.cards_per_open
           FROM pack_cards pc
           JOIN cards c ON c.id = pc.card_id
           WHERE pc.pack_id = p.id
         ),
         0
       )::text AS ev_per_open
     FROM one_time_packs otp
     JOIN packs p ON p.id = otp.pack_id AND p.pack_type = 'reward'
     ORDER BY otp.reward_slug, p.slug`,
  );
  return rows.map((r) => ({
    rewardSlug: r.reward_slug,
    rewardName: r.reward_name,
    packId: r.pack_id,
    packName: r.pack_name,
    packSlug: r.pack_slug,
    cardsPerOpen: Number(r.cards_per_open),
    theoreticalEvUsd: toNumber(r.ev_per_open),
    imageUrl: null,
    cardPreviews: [],
  }));
}

type PackVisualSqlRow = {
  pack_id: string;
  image_url: string | null;
  card_previews: { name: string; image_url: string | null; price: string }[] | null;
};

function parseCardPreviews(
  raw: PackVisualSqlRow["card_previews"],
): PackCardPreview[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    name: c.name,
    imageUrl: c.image_url,
    priceUsd: toNumber(c.price),
  }));
}

/** Pack art + top weighted cards for planner previews. Read-only. */
async function fetchPackVisuals(
  packIds: string[],
): Promise<Map<string, { imageUrl: string | null; cardPreviews: PackCardPreview[] }>> {
  const unique = [...new Set(packIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await queryMainRows<PackVisualSqlRow[]>(
    `SELECT
       p.id::text AS pack_id,
       p.image_url,
       (
         SELECT COALESCE(json_agg(row_to_json(sub)), '[]'::json)
         FROM (
           SELECT c.name, c.image_url, c.price::text AS price
           FROM pack_cards pc
           JOIN cards c ON c.id = pc.card_id
           WHERE pc.pack_id = p.id
           ORDER BY pc.weight DESC
           LIMIT 4
         ) sub
       ) AS card_previews
     FROM packs p
     WHERE p.id = ANY($1::uuid[])`,
    unique,
  );

  return new Map(
    rows.map((r) => [
      r.pack_id,
      {
        imageUrl: r.image_url,
        cardPreviews: parseCardPreviews(r.card_previews),
      },
    ]),
  );
}

/** Every reward pack in the catalog — gallery + visual enrichment source. */
async function getRewardPackCatalog(): Promise<RewardPackCatalogItem[]> {
  type Row = {
    id: string;
    name: string;
    slug: string;
    image_url: string | null;
    active: boolean;
    cards_per_open: number;
    theoretical_ev: string;
  };
  const rows = await queryMainRows<Row[]>(
    `SELECT
       p.id::text,
       p.name,
       p.slug,
       p.image_url,
       p.active,
       p.cards_per_open,
       COALESCE(
         (
           SELECT (SUM(pc.weight::numeric * c.price::numeric) / NULLIF(SUM(pc.weight::numeric), 0))
                  * p.cards_per_open
           FROM pack_cards pc
           JOIN cards c ON c.id = pc.card_id
           WHERE pc.pack_id = p.id
         ),
         0
       )::text AS theoretical_ev
     FROM packs p
     WHERE p.pack_type = 'reward'
     ORDER BY p.name`,
  );
  const visuals = await fetchPackVisuals(rows.map((r) => r.id));
  return rows.map((r) => {
    const v = visuals.get(r.id);
    return {
      packId: r.id,
      name: r.name,
      slug: r.slug,
      active: r.active,
      cardsPerOpen: Number(r.cards_per_open),
      theoreticalEvUsd: toNumber(r.theoretical_ev),
      imageUrl: v?.imageUrl ?? r.image_url,
      cardPreviews: v?.cardPreviews ?? [],
    };
  });
}

function enrichWithPackVisuals<T extends { packId: string }>(
  row: T,
  visuals: Map<string, { imageUrl: string | null; cardPreviews: PackCardPreview[] }>,
): T & PackVisualFields {
  const v = visuals.get(row.packId);
  return {
    ...row,
    imageUrl: v?.imageUrl ?? null,
    cardPreviews: v?.cardPreviews ?? [],
  };
}

/**
 * Fetch + assemble the real baseline for a window. Cached per-period.
 *
 * The config reads (rakeback / affiliate ladders) are period-agnostic (the same
 * regardless of window) but are fetched here so the whole baseline is one cache
 * entry per period — they're cheap `findMany`s.
 */
async function buildBaseline(
  period: InsightsRewardsPeriod,
): Promise<SystemEdgeBaseline> {
  const window = windowFor(period);
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const [
    metricsRes,
    legsRes,
    upgRes,
    rakebackCostRes,
    affiliateCostRes,
    depositBonusCostRes,
    raceCostRes,
    raffleRes,
    dailyPacksRes,
    signupRes,
    welcomePacksRes,
    mothaRes,
    rewardCatalogRes,
    rakebackCfgRes,
    affiliateCfgRes,
    affiliateOvRes,
  ] = await Promise.all([
    safeQuery(
      () => getWindowMetrics({ window }),
      null,
      "system-edge-plan.metrics",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getPackBattleLegs(window),
      null,
      "system-edge-plan.pack-battle-legs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => upgraderMetrics(window),
      null,
      "system-edge-plan.upgrader",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: RAKEBACK_TYPES, window }),
      0,
      "system-edge-plan.rakeback-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: AFFILIATE_TYPES, window }),
      0,
      "system-edge-plan.affiliate-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: DEPOSIT_BONUS_TYPES, window }),
      0,
      "system-edge-plan.deposit-bonus-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: RACE_TYPES, window }),
      0,
      "system-edge-plan.race-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRaffleForecastBaseline(period),
      null,
      "system-edge-plan.raffle",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      // Per-pack daily-pack breakdown (one row per real reward pack with its
      // measured EV/open + opens) — the editable-EV lever source. The total
      // giveaway cost is still derived from the SAME result (gross, not net —
      // see daily-packs.ts), so nothing double-counts the wager.
      () => getDailyPacksGiveaway(period),
      null,
      "system-edge-plan.daily-packs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getSignupOverview(period),
      null,
      "system-edge-plan.signup",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      // Welcome / one-time reward packs + theoretical EVs (display-only
      // context). Read-only catalog read; period-agnostic.
      () => getWelcomePacks(),
      [],
      "system-edge-plan.welcome-packs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      // Motha (founder giveaway account) outflow over the window. Same
      // three channels (creator_tip + battle_sponsorship + rain_tips) as
      // the dashboard "Motha giveaways" line — surfaced here as a named
      // line in the per-lever breakdown (no lever; the founder's giveaway
      // budget is a personal decision, not a system-config knob). NOT
      // double-counted with the canonical reward cost: every motha row is
      // RESIDUAL / WAGER / rain-funding canonically, so it lives outside
      // `getRewardCost`.
      () => getMothaGiveawayOverview(period),
      null,
      "system-edge-plan.motha",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRewardPackCatalog(),
      [],
      "system-edge-plan.reward-pack-catalog",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRakebackConfigs(),
      [],
      "system-edge-plan.rakeback-config",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAffiliateLevelConfigs(),
      [],
      "system-edge-plan.affiliate-config",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAffiliateOverview(period),
      null,
      "system-edge-plan.affiliate-overview",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const metrics = metricsRes.data;

  // Per-type gaming legs (real). When the legs read failed, fall back to a
  // single blended "packs" row carrying the canonical headline so the page
  // still renders a real projection rather than zeros.
  const legs = legsRes.data;
  const upg = upgRes.data ?? null;
  let gameTypes: GameTypeBaseline[];
  if (legs != null) {
    gameTypes = buildGameTypes(legs, upg);
  } else {
    // Degraded: no per-type split available — represent the headline as a
    // single combined row so the model still has real anchors.
    const wager = metrics?.wager ?? 0;
    const payout = metrics?.gamingPayout ?? 0;
    gameTypes = [
      {
        type: "packs",
        wager,
        payout,
        ggr: wager - payout,
        edge: metrics?.houseEdge ?? null,
        bets: metrics?.bets ?? 0,
        dataAvailable: wager > 0,
      },
      {
        type: "battles",
        wager: 0,
        payout: 0,
        ggr: 0,
        edge: null,
        bets: 0,
        dataAvailable: false,
      },
      {
        type: "upgrader",
        wager: 0,
        payout: 0,
        ggr: 0,
        edge: null,
        bets: 0,
        dataAvailable: upg != null,
      },
    ];
  }

  const legsWager = gameTypes.reduce((s, g) => s + g.wager, 0);
  const wager = metrics?.wager ?? legsWager;
  if (metrics?.wager && legsWager > 0 && Math.abs(metrics.wager - legsWager) > 1) {
    const scale = metrics.wager / legsWager;
    gameTypes = gameTypes.map((g) => ({
      ...g,
      wager: g.wager * scale,
      payout: g.payout * scale,
      ggr: g.ggr * scale,
    }));
  }
  const gamingPayout = gameTypes.reduce((s, g) => s + g.payout, 0);
  const ggr = wager - gamingPayout;
  const bets = gameTypes.reduce((s, g) => s + g.bets, 0);
  const houseEdge =
    metrics?.houseEdge ?? (wager > 0 ? ggr / wager : null);

  const rakebackCost = rakebackCostRes.data ?? 0;
  const affiliateCost = affiliateCostRes.data ?? 0;
  const depositBonusCost = depositBonusCostRes.data ?? 0;
  const raceCost = raceCostRes.data ?? 0;
  // Real reconstructed raffle prize cost (NON-ledger item giveaway). Distinct
  // from races; added on top of the canonical reward cost like daily packs.
  const raffleCost = raffleRes.data?.totalPrizeCost ?? 0;
  // Daily-pack giveaway cost = GROSS giveawayPayout (cards out), NOT net of the
  // ≈$0 wager (the wager already flows through pack_opening into GGR; netting it
  // would double-count — see daily-packs.ts). The per-pack rows carry each
  // pack's measured EV/open for the editable-EV lever.
  const dailyPacksGiveaway = dailyPacksRes.data;
  const dailyPacksCost = dailyPacksGiveaway?.giveawayPayout ?? 0;
  const rewardPackCatalog = rewardCatalogRes.data ?? [];
  const visualByPackId = new Map(
    rewardPackCatalog.map((p) => [
      p.packId,
      { imageUrl: p.imageUrl, cardPreviews: p.cardPreviews },
    ]),
  );
  const dailyPackRows: DailyPackLeverRow[] = (dailyPacksGiveaway?.packs ?? [])
    // Only packs actually opened in the window get an editable row (a pack with
    // 0 opens contributes $0 and has no measured EV to scale).
    .filter((p) => p.opens > 0 && p.giveawayPayout > 0)
    .map((p) =>
      enrichWithPackVisuals(
        {
          packId: p.packId,
          name: p.name,
          slug: p.slug,
          opens: p.opens,
          claimers: p.claimers,
          giveawayPayout: p.giveawayPayout,
          measuredEvUsd: p.opens > 0 ? p.giveawayPayout / p.opens : 0,
        },
        visualByPackId,
      ),
    )
    // Biggest giveaway first so the dominant pack leads the lever list.
    .sort((a, b) => b.giveawayPayout - a.giveawayPayout);

  const signupPacksCost = signupRes.data?.totalCost ?? 0;
  const signupClaimants = signupRes.data?.claimants ?? 0;
  const signupSignups = signupRes.data?.signups ?? 0;
  const signupAvgGrant =
    signupRes.data != null && signupRes.data.claimants > 0
      ? signupRes.data.avgPerClaim
      : null;
  // The misleading "$5.71" = cost amortized over EVERY signup (incl.
  // non-claimers). Surfaced as a secondary efficiency metric, NEVER as the
  // grant. avgPerSignup = avgPerClaim × conversionPct (the bridge the UI shows).
  const signupAvgPerSignup =
    signupRes.data != null && signupRes.data.signups > 0
      ? signupRes.data.avgPerSignup
      : null;
  const signupConversionPct =
    signupRes.data != null && signupRes.data.signups > 0
      ? signupRes.data.claimants / signupRes.data.signups
      : 0;

  // Welcome / one-time reward packs + theoretical EVs (display-only context).
  const welcomePacks: WelcomePackInfo[] = (welcomePacksRes.data ?? []).map((w) =>
    enrichWithPackVisuals(w, visualByPackId),
  );

  const rainCost = metrics?.rainHouseCost ?? 0;
  const rainWinTotal = metrics?.rainWinTotal ?? 0;
  const rainTipTotal = metrics?.rainTipTotal ?? 0;
  // Real motha (founder giveaway account) outflow over the window. NOT in the
  // canonical reward cost: every motha row is canonically RESIDUAL / WAGER /
  // rain-funding (none of which lands in `getRewardCost`), so adding it here
  // as a separate planner line cannot double-count with `otherRewardCost`
  // below. Same shape as `dailyPacksCost` / `raffleCost`: real, reconstructed,
  // added on top.
  const mothaCost = mothaRes.data?.totalCost ?? 0;

  // Other reward cost = the canonical total reward cost (GGR − NGR) minus every
  // lever we itemize, so the planner's reward sum reconciles with NGR. The
  // remainder is gift cards / promo / waitlist / manual vouchers + counted
  // adjustments — held fixed (no lever), surfaced as an informational line.
  //
  // NOTE: the canonical NGR's reward cost includes the daily-pack giveaway via
  // the inventory leg? No — daily packs are EXCLUDED from gaming (Fix 2) and
  // their cost is NOT in the ledger (no ledger row), so the canonical NGR does
  // NOT carry the daily-pack cost. Likewise signup balance_reward_claim IS a
  // ledger reward type, so it IS in the canonical reward cost. To avoid
  // double-counting, `otherRewardCost` subtracts only the LEDGER-resident
  // levers (rakeback / affiliate / deposit bonus / RACE [race_prize] / signup /
  // rain) from the canonical reward cost. Daily packs, raffles, AND motha are
  // NON-ledger / non-reward-canonical lines (raffle prizes never emit a
  // ledger row; motha's three channels are canonically RESIDUAL / WAGER /
  // rain-funding — none in `getRewardCost`), so each is added on top as its
  // own named line and NOT subtracted here. No double-count.
  const canonicalRewardCost = metrics != null ? metrics.ggr - metrics.ngr : 0;
  const ledgerLeverCost =
    rakebackCost +
    affiliateCost +
    depositBonusCost +
    raceCost +
    signupPacksCost +
    rainCost;
  const otherRewardCost = Math.max(0, canonicalRewardCost - ledgerLeverCost);

  // Real rakeback cadences (daily / weekly / monthly) from rakeback_config.
  const rakebackCadences: RakebackCadenceLever[] = (rakebackCfgRes.data ?? [])
    .map((c): RakebackCadenceLever | null => {
      const cadence = normalizeCadence(c.type);
      if (cadence == null) return null;
      return {
        cadence,
        label: c.displayName || cadenceLabel(cadence),
        currentRate: Math.max(0, c.percentage),
        enabled: c.enabled,
      };
    })
    .filter((c): c is RakebackCadenceLever => c != null)
    // Stable order: daily → weekly → monthly.
    .sort((a, b) => cadenceOrder(a.cadence) - cadenceOrder(b.cadence));

  // Real affiliate tiers from affiliate_level_configs.
  const affiliateTiers: AffiliateTierLever[] = (affiliateCfgRes.data ?? [])
    .map((c) => ({
      level: c.level,
      label: c.label || `Level ${c.level}`,
      currentRate: Math.max(0, c.commission_rate),
      threshold: Math.max(0, c.threshold),
    }))
    .sort((a, b) => a.level - b.level);

  // Realized affiliate drag on wager (= total commission ÷ referred wager).
  // Tier ladder rates are shares of edge; divide by house edge for edge share.
  const ov = affiliateOvRes.data;
  const affiliateBlendedRate =
    ov != null && ov.downstreamWager > 0
      ? ov.totalCommissionPaid / ov.downstreamWager
      : null;

  return {
    periodLabel: insightsRewardsPeriodLabel(period),
    periodDays,

    gameTypes,
    wager,
    gamingPayout,
    ggr,
    houseEdge,
    bets,

    rakebackCost,
    affiliateCost,
    depositBonusCost,
    raceCost,
    raffleCost,
    dailyPacksCost,
    signupPacksCost,
    rainCost,
    mothaCost,
    otherRewardCost,

    rakebackCadences,
    affiliateTiers,
    affiliateBlendedRate,

    dailyPackRows,
    rewardPackCatalog,

    signupAvgGrant,
    signupClaimants,
    signupSignups,
    signupAvgPerSignup,
    signupConversionPct,
    welcomePacks,

    depositBonusCapUsd: DEPOSIT_BONUS_BASELINE_CAP_USD,
    depositBonusWindowHours: DEPOSIT_BONUS_BASELINE_WINDOW_HOURS,

    rainWinTotal,
    rainTipTotal,
  };
}

/** Cadence display order: daily → weekly → monthly. */
function cadenceOrder(c: RakebackCadenceId): number {
  return c === "daily" ? 0 : c === "weekly" ? 1 : 2;
}

function cadenceLabel(c: RakebackCadenceId): string {
  return c === "daily" ? "Daily" : c === "weekly" ? "Weekly" : "Monthly";
}

/**
 * A fully-zeroed, serializable baseline. The last-resort fallback if the whole
 * `buildBaseline` (or the cache machinery) ever throws for a reason NOT caught
 * by the per-query `safeQuery` wrappers (e.g. an unexpected post-processing
 * error or an `unstable_cache` infra error). Returning this — rather than
 * letting the throw bubble — keeps the page from collapsing into the insights
 * error boundary: `wager <= 0` makes the content layer render its clean
 * "no gameplay to anchor on" empty state instead. Belt-and-braces on top of the
 * per-query guards.
 */
function emptyBaseline(period: InsightsRewardsPeriod): SystemEdgeBaseline {
  const zeroType = (type: GameTypeBaseline["type"]): GameTypeBaseline => ({
    type,
    wager: 0,
    payout: 0,
    ggr: 0,
    edge: null,
    bets: 0,
    dataAvailable: false,
  });
  return {
    periodLabel: insightsRewardsPeriodLabel(period),
    periodDays: Math.max(1, daysForInsightsPeriodCapped(period)),
    gameTypes: [zeroType("packs"), zeroType("battles"), zeroType("upgrader")],
    wager: 0,
    gamingPayout: 0,
    ggr: 0,
    houseEdge: null,
    bets: 0,
    rakebackCost: 0,
    affiliateCost: 0,
    depositBonusCost: 0,
    raceCost: 0,
    raffleCost: 0,
    dailyPacksCost: 0,
    signupPacksCost: 0,
    rainCost: 0,
    mothaCost: 0,
    otherRewardCost: 0,
    rakebackCadences: [],
    affiliateTiers: [],
    affiliateBlendedRate: null,
    dailyPackRows: [],
    rewardPackCatalog: [],
    signupAvgGrant: null,
    signupClaimants: 0,
    signupSignups: 0,
    signupAvgPerSignup: null,
    signupConversionPct: 0,
    welcomePacks: [],
    depositBonusCapUsd: DEPOSIT_BONUS_BASELINE_CAP_USD,
    depositBonusWindowHours: DEPOSIT_BONUS_BASELINE_WINDOW_HOURS,
    rainWinTotal: 0,
    rainTipTotal: 0,
  };
}

/**
 * Public entry — the cached baseline for a period. `unstable_cache` keyed on the
 * period with a period-aware TTL (60s short windows / 300s lifetime), mirroring
 * the insights-rewards cache discipline.
 *
 * Wrapped in `safeQuery` as the OUTERMOST guard: every individual aggregate
 * inside `buildBaseline` is already `safeQuery`-wrapped (so one failing query
 * only degrades its own lever), and this final wrapper catches any residual
 * throw from the assembly or the cache layer itself — so the page can NEVER
 * collapse to the insights error boundary from this read. On total failure it
 * degrades to a zeroed `emptyBaseline`, which the content layer renders as the
 * clean "no gameplay to anchor on" empty state.
 */
export async function getSystemEdgeBaseline(
  period: InsightsRewardsPeriod,
): Promise<SystemEdgeBaseline> {
  const cached = unstable_cache(
    () => buildBaseline(period),
    // v6: reward pack catalog + pack art/card previews on daily + welcome rows;
    // other + motha cost multipliers in the planner model.
    ["system-edge-plan-baseline-v7", period],
    { revalidate: cacheTtlForInsightsPeriod(period) },
  );
  const { data } = await safeQuery(
    () => cached(),
    emptyBaseline(period),
    "system-edge-plan.baseline",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return data;
}
