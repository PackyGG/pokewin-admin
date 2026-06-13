import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/utils/time";
import { getMetricsScope } from "@/lib/metrics/scope";
import { upgraderMetrics } from "@/lib/metrics/queries";
import { GAMING_PAYOUT_TYPES_SQL } from "@/lib/metrics/ledger-sets";
// READ-ONLY import of the CANONICAL borrow/reward-pack predicates. These are
// the SAME fragments `@/lib/metrics/queries.ts` (`getGamingLegs` /
// `getWindowMetrics`) uses for the headline GGR, so the per-product split
// computed here reconciles with the headline BY CONSTRUCTION — whatever the
// current borrow basis is (borrow-exclusive today, borrow-inclusive after the
// gaming-sql fix lands), this module inherits it automatically because it
// imports the predicates rather than re-deriving them.
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
import { INSIGHTS_HUB_WAGER_LOOKBACK_DAYS } from "./hub-wager";

/**
 * real-numbers.ts — the per-PRODUCT GGR split for the "Real Numbers"
 * (Source of Truth) page.
 *
 * It is a THIN reconciling assembly on top of the canonical `@/lib/metrics`
 * layer, NOT new money math. The page's headline GGR / NGR / reward cost /
 * P&L all come from `getCostBreakdown` (which is itself an assembly of
 * `getWindowMetrics` + `calculateWindowedPnl`); this module only adds the
 * one thing the canonical layer does not expose directly — GGR broken out
 * per game line (packs / battles / upgrader) — and it does so on the EXACT
 * same scope, window and borrow/reward-pack predicates the headline uses,
 * so the three per-game GGRs SUM to the headline GGR by construction.
 *
 * ─── How the split maps onto the canonical legs ─────────────────────
 *
 * The canonical gaming payout (`getGamingLegs`) is:
 *   inventory payout (source pack+battle, PAYOUT_LEG_FILTER)
 *     + ledger gaming payout (battle_refund + battle_excess_to_voucher)
 *     + upgrader payout (upgrader_games.won_amount)
 * and the canonical wager is:
 *   ledger WAGER_TYPES (pack_opening + battle_bet + battle_sponsorship,
 *     WAGER_LEG_FILTER) + upgrader wager (upgrader_games.bet_amount).
 *
 * We attribute each leg to its product:
 *   • PACKS   — wager: pack_opening (WAGER_LEG_FILTER);
 *               payout: inventory source_type='pack' (PAYOUT_LEG_FILTER).
 *   • BATTLES — wager: battle_bet + battle_sponsorship (WAGER_LEG_FILTER);
 *               payout: inventory source_type='battle' (PAYOUT_LEG_FILTER)
 *               + the ledger gaming-payout legs (battle_refund +
 *               battle_excess_to_voucher — both are battle-win settlement
 *               legs).
 *   • UPGRADER — wager/payout straight from `upgraderMetrics`.
 *
 * Pack wager + battle wager + upgrader wager = canonical wager; pack payout
 * + battle payout + upgrader payout = canonical gaming payout; therefore
 * Σ per-game GGR = canonical GGR. The page asserts this and surfaces a tiny
 * reconciliation residual if a future leg appears that this split missed.
 *
 * Scope: the canonical real-customer scope (`getMetricsScope` — staff +
 * creators + blacklist dropped, creator-on-session rows excluded). Window:
 * the SAME 365d lifetime cap the /insights hub wager uses
 * ({@link INSIGHTS_HUB_WAGER_LOOKBACK_DAYS}). Read-only against the Main DB,
 * cached 5 min via `unstable_cache` keyed on the cutoff + scope inputs.
 */

/** One game line's gaming-margin economics. */
export type GameGgrRow = {
  /** Stable key. */
  key: "packs" | "battles" | "upgrader";
  /** Display label. */
  label: string;
  /** Σ wager (stake placed), real customers, borrow-corrected. */
  wager: number;
  /** Σ gaming payout returned to users (inventory + cash legs). */
  payout: number;
  /** GGR = wager − payout (house POV; positive = house up). */
  ggr: number;
  /** Return-to-player = payout / wager (0..1), or null when no wager. */
  rtp: number | null;
  /** House edge = GGR / wager (0..1), or null when no wager. */
  houseEdge: number | null;
};

export type RealNumbersGameSplit = {
  /** Per-product GGR rows in display order (packs, battles, upgrader). */
  games: GameGgrRow[];
  /** Σ of the per-game wager (= canonical wager). */
  totalWager: number;
  /** Σ of the per-game gaming payout (= canonical gaming payout). */
  totalPayout: number;
  /** Σ of the per-game GGR (= canonical headline GGR, by construction). */
  totalGgr: number;
  /** ISO cutoff of the lifetime window (now − 365d). */
  cutoffIso: string;
  /** The lifetime lookback cap (days) used — for the provenance line. */
  lookbackDays: number;
};

/** "now" floored to the whole minute so the cache key is stable for 60s. */
function bucketedNow(): Date {
  return new Date(Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/**
 * The cached inner read. The cutoff ISO + the scope inputs
 * (`userScopeSql`, `sessionWindowsCte`, the resolved per-row predicates) are
 * all baked into the cache key so a changed blacklist / creator-session set
 * can never serve a stale value. Tagged with the canonical insights tags so
 * an exclusion change or a wipe/restore busts it alongside the other
 * insights caches.
 */
const cachedGameSplit = unstable_cache(
  async (
    cutoffIso: string,
    userScopeSql: string,
    sessionWindowsCte: string,
    notInCreatorSessionLedger: string,
    notInCreatorSessionInv: string,
  ): Promise<{
    packWager: number;
    battleWager: number;
    packInvPayout: number;
    battleInvPayout: number;
    battleLedgerPayout: number;
    upgraderWager: number;
    upgraderPayout: number;
  }> => {
    const db = await getDb();
    const since = `'${cutoffIso}'::timestamptz`;

    type WagerRow = { pack_wager: string; battle_wager: string };
    type InvRow = { pack_inv: string; battle_inv: string };
    type LedgerPayoutRow = { battle_ledger_payout: string };

    const [wagerRows, invRows, ledgerPayoutRows, upg] = await Promise.all([
      // Per-product WAGER from the ledger, under the canonical WAGER_LEG_FILTER
      // (the SAME predicate getGamingLegs applies). pack_opening → packs;
      // battle_bet + battle_sponsorship → battles. battle_sponsorship is
      // counted directly (no borrow gate) exactly as the headline does.
      db.$queryRawUnsafe<WagerRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening'
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship')
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ('pack_opening','battle_bet','battle_sponsorship')
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}
           AND ${WAGER_LEG_FILTER}`,
      ),
      // Per-product INVENTORY payout, under the canonical PAYOUT_LEG_FILTER
      // (the SAME predicate getGamingLegs applies). source_type splits the
      // two products; the borrow + reward-pack exclusion is identical.
      db.$queryRawUnsafe<InvRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN source_type = 'pack'
             THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS pack_inv,
           COALESCE(SUM(CASE WHEN source_type = 'battle'
             THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battle_inv
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionInv}
           AND obtained_at >= ${since}
           AND ${PAYOUT_LEG_FILTER}`,
      ),
      // The LEDGER gaming-payout legs (battle_refund + battle_excess_to_voucher)
      // — both are battle-win settlement legs, so they belong to battles. Same
      // GAMING_PAYOUT_TYPES set + scope getGamingLegs sums; no borrow flag on
      // these legs (summed unconditionally within the type filter), matching
      // the headline.
      db.$queryRawUnsafe<LedgerPayoutRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(ABS(amount::numeric)), 0)::text AS battle_ledger_payout
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ${GAMING_PAYOUT_TYPES_SQL}
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}`,
      ),
      // Upgrader straight from the canonical reader (to_regclass-guarded →
      // null on a pre-upgrader DB).
      upgraderMetrics({ since: new Date(cutoffIso) }),
    ]);

    return {
      packWager: toNumber(wagerRows[0]?.pack_wager),
      battleWager: toNumber(wagerRows[0]?.battle_wager),
      packInvPayout: toNumber(invRows[0]?.pack_inv),
      battleInvPayout: toNumber(invRows[0]?.battle_inv),
      battleLedgerPayout: toNumber(ledgerPayoutRows[0]?.battle_ledger_payout),
      upgraderWager: upg?.wager ?? 0,
      upgraderPayout: upg?.payout ?? 0,
    };
  },
  ["insights-real-numbers-game-split-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

function makeRow(
  key: GameGgrRow["key"],
  label: string,
  wager: number,
  payout: number,
): GameGgrRow {
  const ggr = wager - payout;
  return {
    key,
    label,
    wager,
    payout,
    ggr,
    rtp: wager > 0 ? payout / wager : null,
    houseEdge: wager > 0 ? ggr / wager : null,
  };
}

/**
 * Per-product GGR split (packs / battles / upgrader) over the lifetime
 * window, on the canonical real-customer + borrow-corrected scope.
 *
 * Reconciles with the headline `getCostBreakdown(...).ggr` /
 * `getWindowMetrics(...).ggr` by construction: it sums the SAME canonical
 * legs (ledger wager under WAGER_LEG_FILTER, inventory payout under
 * PAYOUT_LEG_FILTER, the GAMING_PAYOUT_TYPES ledger legs, and upgrader),
 * just partitioned by product. Read-only.
 */
export async function getRealNumbersGameSplit(): Promise<RealNumbersGameSplit> {
  return withTiming("insights.realNumbers.gameSplit", async () => {
    const now = bucketedNow();
    const cutoff = new Date(
      now.getTime() - INSIGHTS_HUB_WAGER_LOOKBACK_DAYS * MS_PER_DAY,
    );
    const cutoffIso = cutoff.toISOString();

    const scope = await getMetricsScope();
    const legs = await cachedGameSplit(
      cutoffIso,
      scope.userScopeSql,
      scope.sessionWindowsCte,
      scope.notInCreatorSession("user_id", "created_at"),
      scope.notInCreatorSession("user_id", "obtained_at"),
    );

    const packs = makeRow("packs", "Packs", legs.packWager, legs.packInvPayout);
    const battles = makeRow(
      "battles",
      "Battles",
      legs.battleWager,
      legs.battleInvPayout + legs.battleLedgerPayout,
    );
    const upgrader = makeRow(
      "upgrader",
      "Upgrader",
      legs.upgraderWager,
      legs.upgraderPayout,
    );

    const games = [packs, battles, upgrader];
    const totalWager = games.reduce((s, g) => s + g.wager, 0);
    const totalPayout = games.reduce((s, g) => s + g.payout, 0);
    const totalGgr = games.reduce((s, g) => s + g.ggr, 0);

    return {
      games,
      totalWager,
      totalPayout,
      totalGgr,
      cutoffIso,
      lookbackDays: INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
    };
  });
}
