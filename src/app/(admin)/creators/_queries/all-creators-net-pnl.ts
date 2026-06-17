import "server-only";

import { cache } from "react";
import { unstable_cache } from "next/cache";

import { getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
import { getMetricsScope } from "@/lib/metrics/scope";
import { ggr as ggrFormula, gamingPayoutTotal } from "@/lib/metrics/formulas";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getAllCreatorsNetGgrScansFromClickHouse } from "@/lib/clickhouse/queries/creators/net-ggr";

/**
 * all-creators-net-pnl.ts — the BATCH (all-creators) variant of the
 * canonical attribution-windowed code-user GGR, for the /creators LIST.
 *
 * This is the Term-1 (code-user GGR) side ONLY, computed for EVERY creator
 * in ONE pass. The Term-2 cost side is intentionally NOT batched here: the
 * per-creator cost (multiplier + leaderboard) is sourced from BACKEND
 * round-trips (`getCreatorTotalCost` / `getCreatorMultiplierCost` /
 * `getCreatorLeaderboardCost`), so folding it into a list of N creators
 * would fire 2·N backend calls — exactly the eager-load anti-pattern
 * CLAUDE.md's active-timeframe rule forbids. A list surface should render
 * the windowed GGR per creator and fetch the full cost breakdown lazily on
 * drill-in (the single-creator `getCreatorNetPnl`). If a list ever needs a
 * cost column, batch the cost from the backend separately (paginated) and
 * merge in code — keep this SQL pure GGR.
 *
 * ─── Attribution (same model as the single-creator path) ─────────────
 *
 * Each canonical gaming event is attributed to the creator whose code's
 * 7-day coverage window covered the user at the event time, with the
 * MOST-RECENT covering acu winning on overlap (code-hopping → latest
 * creator) and the creator's own self-attributed play dropped
 * (`referred_user_id <> affiliate_user_id`). Implemented as a per-row
 * correlated scalar subquery (`ORDER BY acu.created_at DESC LIMIT 1`) —
 * the same "most recent covering acu wins" tiebreak the existing
 * `getAllCreatorsLifetimePnl` uses for deposits — generalised from
 * deposits to ALL gaming legs (wager, ledger gaming payout, inventory
 * payout, upgrader). The source tables stay UNALIASED so the shared
 * `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` predicates (bare-column, with
 * their own embedded sub-selects) drop in verbatim — exactly as the
 * canonical `getGamingLegs` consumes them.
 *
 * ─── Scope + booking model (same as the canonical metric layer) ──────
 *
 * Reuses `getMetricsScope` (staff + blacklist dropped, creator-on-session
 * rows excluded symmetrically on wager + payout) and the shared
 * `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` borrow + reward-pack predicates
 * + the canonical type SQL — so each creator's GGR is on the SAME
 * population + booking model as the headline GGR, narrowed to their cohort.
 * Per-creator GGRs therefore sum cleanly toward (a subset of) the headline.
 *
 * Active-timeframe-only: one window per call.
 */

export type CreatorNetGgrRow = {
  creatorUserId: string;
  username: string | null;
  image: string | null;
  /** Canonical GGR for this creator's cohort over the window. */
  ggr: number;
  wager: number;
  gamingPayout: number;
  inventoryPayout: number;
  ledgerGamingPayout: number;
  upgraderWager: number;
  upgraderPayout: number;
};

/**
 * Roster-wide GGR legs — the SAME canonical components the dashboard's
 * `getGgrBreakdown` surfaces, summed across the whole creator cohort
 * (only `role = 'creator'` attributed ids — identical gate to
 * `byCreator`). These are aggregated in-loop from the per-creator
 * components already computed below, so they add NO extra query: the
 * cohort breakdown reconciles to `totalGgr` by construction
 * (`packBattleWager + upgraderWager − inventoryPayout − battleRefundLedger
 * − upgraderPayout = totalGgr`).
 *
 * Mirrors the dashboard popover's wager-side (pack/battle stake + upgrader
 * stake) and payout-side (pack/battle inventory wins + battle refunds +
 * upgrader payout) split.
 */
export type CohortGgrLegs = {
  /** Ledger pack/battle stake (upgrader carved out). Wager-side. */
  packBattleWager: number;
  /** Upgrader stake (`upgrader_games.bet_amount`). Wager-side. */
  upgraderWager: number;
  /** Pack/battle wins valued from inventory (the dominant payout). */
  inventoryPayout: number;
  /** Ledger cash gaming-payout legs — battle refunds. */
  battleRefundLedger: number;
  /** Upgrader payout (`upgrader_games.won_amount`). */
  upgraderPayout: number;
  /** Σ wager-side legs (packBattleWager + upgraderWager). */
  wagersTotal: number;
  /** Σ payout-side legs (inventoryPayout + battleRefundLedger + upgraderPayout). */
  payoutsTotal: number;
};

export type AllCreatorsNetGgr = {
  period: DashboardPeriod;
  /** Σ ggr across all creators in the result (cohort-attributed). */
  totalGgr: number;
  /**
   * Roster-wide GGR legs (wager/payout per source) summed across the
   * cohort — backs the breakdown list-down on the /creators "Net
   * Code-User GGR" tile. Reconciles to `totalGgr` by construction.
   */
  legs: CohortGgrLegs;
  /** Per-creator rows, sorted by GGR descending (biggest house win first). */
  byCreator: CreatorNetGgrRow[];
};

/**
 * Map a `DashboardPeriod` to a Postgres `INTERVAL` literal, or `null` for
 * the lifetime ("all") window. Hardcoded literals only (no interpolation
 * risk). Used inside the cached scan so the cutoff is computed at FILL
 * time from `NOW()` rather than threaded in as a timestamp — keeping the
 * cache key the coarse `period` label, not a per-render timestamp that
 * would never hit.
 */
/**
 * Map a `DashboardPeriod` to a since-`Date` relative to `now`, or `null` for
 * the lifetime ("all") window. Used to anchor BOTH engines (the anchored PG
 * `sinceClause` AND the ClickHouse twin's `since` param) to one instant per
 * cache entry, so the comparison/cutover is deterministic — same pattern as
 * the creator-hub cohort twin (`hubPeriodToSinceDate`).
 */
function periodToSinceDate(period: DashboardPeriod, now: Date): Date | null {
  const ms: Record<Exclude<DashboardPeriod, "all">, number> = {
    "1h": 3_600_000,
    "3h": 3 * 3_600_000,
    "6h": 6 * 3_600_000,
    "12h": 12 * 3_600_000,
    "24h": 24 * 3_600_000,
    "48h": 48 * 3_600_000,
    "3d": 3 * 86_400_000,
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
  };
  if (period === "all") return null;
  return new Date(now.getTime() - ms[period]);
}

type LedgerRow = {
  creator_id: string;
  wager: string;
  ledger_payout: string;
};
type InvRow = { creator_id: string; inv_payout: string };
type UpgRow = { creator_id: string; upg_wager: string; upg_payout: string };
type NetGgrScans = {
  ledgerRows: LedgerRow[];
  invRows: InvRow[];
  upgRows: UpgRow[];
};

/**
 * The three heavy attribution scans behind `getAllCreatorsNetGgr`, wrapped
 * in `unstable_cache` so a cold run populates a cross-request slot and
 * every subsequent render (any viewer, any tab, the strip tile + the
 * per-row GGR merge) serves the cached rows instantly. Revalidate 300s:
 * the 24h GGR moves as new gameplay lands, but a ≤5-min staleness is fine
 * for a roster KPI, and it means the heavy ledger/inventory scan runs at
 * most once per 5 min per (window × scope) instead of on every request —
 * the fix for the tile timing out to "—" on a cold render.
 *
 * ── Set-based attribution (was: N correlated scalar subqueries) ──────
 *
 * The covering creator per event row is resolved by a `LEFT JOIN LATERAL`
 * against `affiliate_code_usages` (most-recent covering acu in the 7-day
 * window wins, the creator's own play dropped) — the SAME semantics as the
 * prior `(SELECT … ORDER BY acu.created_at DESC LIMIT 1)` scalar subquery,
 * but expressed as ONE join the planner resolves in a single pass per leg
 * rather than re-running a correlated subquery for every scanned row. The
 * `LIMIT 1` inside the lateral preserves the exact "latest acu wins" tie-
 * break on code-hopping. Source tables stay UNALIASED so the shared
 * `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` bare-column predicates drop in
 * verbatim.
 *
 * The window cutoff is computed at fill time via `NOW() - INTERVAL` from
 * the `period` label (not threaded in as a timestamp) so the cache key
 * stays the coarse window, not a per-render instant.
 *
 * Scope/env/probe inputs are resolved OUTSIDE this cache (they read the
 * backend session windows + admin-DB blacklist + the request cookie) and
 * passed in — `cookies()` cannot be read inside an `unstable_cache`
 * callback, and threading the resolved fragments + env as arguments folds
 * them into the cache key automatically (Next serializes the args), so a
 * changed scope (new blacklist entry, refreshed session windows) or a
 * dev-toggled admin lands in a separate slot. Inside, the client is
 * selected straight from the resolved `env` (never re-reading the cookie).
 */
const cachedNetGgrScans = (
  period: DashboardPeriod,
  env: DbEnv,
  exclLedger: string,
  exclInventory: string,
  upgBlacklist: string,
  hasUpgrader: boolean,
  excluded: string[],
) =>
  unstable_cache(
    async (): Promise<NetGgrScans> => {
      const db = env === "dev" ? getDevDb() : getProdDb();
      // Anchor BOTH engines to a single instant so the Postgres leg and the
      // ClickHouse twin are deterministically comparable (mirrors the
      // creator-hub cohort twin). The anchor is fixed per unstable_cache entry
      // (revalidate 300s).
      const now = new Date();
      const sinceDate = periodToSinceDate(period, now);
      const sinceClause = (col: string): string =>
        sinceDate === null
          ? ""
          : `AND ${col} >= '${sinceDate.toISOString()}'::timestamptz`;

      // Covering-creator lateral: the most-recent acu whose 7-day window
      // covers this event row, the creator's own play dropped. `userCol` /
      // `tsCol` are bare unaliased columns of the outer source row —
      // inlined verbatim, hardcoded identifiers only.
      const coveringLateral = (userCol: string, tsCol: string): string =>
        `LEFT JOIN LATERAL (
           SELECT acu.affiliate_user_id AS creator_id
             FROM affiliate_code_usages acu
            WHERE acu.referred_user_id = ${userCol}
              AND acu.referred_user_id <> acu.affiliate_user_id
              AND acu.created_at <= ${tsCol}
              AND acu.created_at >= ${tsCol} - INTERVAL '7 days'
            ORDER BY acu.created_at DESC
            LIMIT 1
         ) cov ON TRUE`;

      // Index-or-ClickHouse: serve the 3 heavy attribution scans from the
      // ClickHouse twin when cut over (gated per surface key); the in-code
      // merge below runs unchanged on either source. The CH twin is parity-
      // proven cent-exact (TZ=UTC, twice) against the anchored Postgres legs.
      return resolveAdminRead<NetGgrScans>("creators_net_ggr", {
        ch: () => getAllCreatorsNetGgrScansFromClickHouse(excluded, sinceDate),
        pg: async () => {
      const [ledgerRows, invRows, upgRows] = await Promise.all([
        // Ledger wager + ledger gaming payout, attributed per covering
        // creator via the lateral. UNALIASED `ledger_transactions` so
        // WAGER_LEG_FILTER drops in verbatim; outer GROUPs by the lateral's
        // creator_id, keeping only attributed rows.
        db.$queryRawUnsafe<LedgerRow[]>(
          `SELECT cov.creator_id,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type IN ${WAGER_TYPES_SQL} THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS wager,
                  COALESCE(SUM(CASE WHEN ledger_transactions.type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(ledger_transactions.amount::numeric) ELSE 0 END), 0)::text AS ledger_payout
             FROM ledger_transactions
             ${coveringLateral("user_id", "created_at")}
            WHERE status = 'completed'
              ${sinceClause("created_at")}
              AND ${WAGER_LEG_FILTER}
              ${exclLedger}
              AND cov.creator_id IS NOT NULL
            GROUP BY cov.creator_id`,
        ),
        // Inventory pack/battle payout, attributed per covering creator
        // keyed on obtained_at (symmetric with the wager side). UNALIASED
        // `user_inventory` so PAYOUT_LEG_FILTER drops in verbatim.
        db.$queryRawUnsafe<InvRow[]>(
          `SELECT cov.creator_id,
                  COALESCE(SUM(user_inventory.value_at_obtained::numeric), 0)::text AS inv_payout
             FROM user_inventory
             ${coveringLateral("user_id", "obtained_at")}
            WHERE source_type IN ('pack','battle')
              ${sinceClause("obtained_at")}
              AND ${PAYOUT_LEG_FILTER}
              ${exclInventory}
              AND cov.creator_id IS NOT NULL
            GROUP BY cov.creator_id`,
        ),
        // Upgrader plays, attributed per covering creator. Wholesale-
        // creator-drop real-customer scope (matching the shared
        // upgraderMetrics reader). Skipped (empty) on a pre-upgrader DB.
        hasUpgrader
          ? db.$queryRawUnsafe<UpgRow[]>(
              `SELECT cov.creator_id,
                      COALESCE(SUM(upgrader_games.bet_amount::numeric), 0)::text AS upg_wager,
                      COALESCE(SUM(upgrader_games.won_amount::numeric), 0)::text AS upg_payout
                 FROM upgrader_games
                 ${coveringLateral("user_id", "created_at")}
                WHERE user_id IN (
                    SELECT u_ug.id FROM "user" u_ug
                     WHERE u_ug.role NOT IN ('admin', 'support', 'creator') ${upgBlacklist}
                  )
                  ${sinceClause("created_at")}
                  AND cov.creator_id IS NOT NULL
                GROUP BY cov.creator_id`,
            )
          : Promise.resolve([] as UpgRow[]),
      ]);

          return { ledgerRows, invRows, upgRows };
        },
      });
    },
    ["creators-net-ggr-scans-v1", period, env, exclLedger, exclInventory, upgBlacklist, String(hasUpgrader)],
    { revalidate: 300, tags: ["creators-net-ggr"] },
  );

/**
 * Batch attribution-windowed code-user GGR for EVERY creator over a window.
 *
 * Three reads (see {@link cachedNetGgrScans}), each attributing every event
 * row to its covering creator via a `LEFT JOIN LATERAL` and grouping by it:
 *   • ledger wager + ledger gaming-payout legs (keyed on created_at),
 *   • inventory pack/battle payout (keyed on obtained_at),
 *   • upgrader plays (keyed on created_at) when `upgrader_games` exists,
 * merged in code into GGR = wager − gamingPayout per creator.
 *
 * The creator-on-session exclusion uses the inline-fragment form of the
 * scope (`exclStaffSessionFrag`, default bare-column) so each leg stays a
 * flat query over the UNALIASED source table. Staff + blacklist +
 * session-window drop are identical to the CTE form — they resolve from
 * the same `getMetricsScope` snapshot.
 *
 * Two cache layers stack: the heavy SQL scans are `unstable_cache`d
 * cross-request (300s, keyed on window × scope × env) so the cold run
 * populates a shared slot and every later render is instant — the fix for
 * the tile timing out to "—". This outer `cache()` then dedupes the merge
 * within a single render (the KPI strip's roster-wide GGR tile + the
 * per-row GGR merge in the grid both consult it).
 */
export const getAllCreatorsNetGgr = cache(async function getAllCreatorsNetGgr(
  period: DashboardPeriod,
): Promise<AllCreatorsNetGgr> {
  return withTiming("creators.allNetGgr", async () => {
    // Resolve scope/env/probe in REQUEST scope (cookie + backend + admin-DB
    // reads that can't run inside the unstable_cache callback), then hand
    // them to the cached scan so prod/dev and each scope land in their own
    // cross-request slot.
    const env = await readDbEnv();
    const probeDb = env === "dev" ? getDevDb() : getProdDb();
    const scope = await getMetricsScope();
    const excluded = await getExcludedUserIds();

    // Self-contained staff + blacklist + creator-on-session fragment, in
    // the DEFAULT bare-column form (`user_id` / the given ts column). The
    // source tables are deliberately UNALIASED so the shared
    // `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` fragments (which reference
    // bare `type` / `game_session_id` / `source_type` / `source_id`, and
    // embed their own table-qualified sub-selects) drop in verbatim —
    // exactly as the canonical `getGamingLegs` consumes them. Aliasing the
    // outer table would force a regex rewrite that would also corrupt the
    // bare columns INSIDE those embedded sub-selects, so we don't alias.
    const exclLedger = scope.exclStaffSessionFrag({ tsCol: "created_at" });
    const exclInventory = scope.exclStaffSessionFrag({ tsCol: "obtained_at" });

    // Probe upgrader_games once — pre-upgrader snapshot returns NULL.
    const upgProbe = await probeDb.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = upgProbe[0]?.exists != null;
    const upgBlacklist = blacklistNotInClause("u_ug.id", excluded);

    const { ledgerRows, invRows, upgRows } = await cachedNetGgrScans(
      period,
      env,
      exclLedger,
      exclInventory,
      upgBlacklist,
      hasUpgrader,
      excluded,
    )();

    // Merge the three creator-keyed sets.
    type Acc = {
      wager: number;
      ledgerGamingPayout: number;
      inventoryPayout: number;
      upgraderWager: number;
      upgraderPayout: number;
    };
    const byId = new Map<string, Acc>();
    const blank = (): Acc => ({
      wager: 0,
      ledgerGamingPayout: 0,
      inventoryPayout: 0,
      upgraderWager: 0,
      upgraderPayout: 0,
    });

    for (const r of ledgerRows) {
      const e = byId.get(r.creator_id) ?? blank();
      e.wager += toNumber(r.wager);
      e.ledgerGamingPayout += toNumber(r.ledger_payout);
      byId.set(r.creator_id, e);
    }
    for (const r of invRows) {
      const e = byId.get(r.creator_id) ?? blank();
      e.inventoryPayout += toNumber(r.inv_payout);
      byId.set(r.creator_id, e);
    }
    for (const r of upgRows) {
      const e = byId.get(r.creator_id) ?? blank();
      e.upgraderWager += toNumber(r.upg_wager);
      e.upgraderPayout += toNumber(r.upg_payout);
      byId.set(r.creator_id, e);
    }

    const emptyLegs: CohortGgrLegs = {
      packBattleWager: 0,
      upgraderWager: 0,
      inventoryPayout: 0,
      battleRefundLedger: 0,
      upgraderPayout: 0,
      wagersTotal: 0,
      payoutsTotal: 0,
    };

    if (byId.size === 0) {
      return { period, totalGgr: 0, legs: emptyLegs, byCreator: [] };
    }

    // Resolve username/image for the attributed creators (Main DB),
    // RESTRICTED to `role = 'creator'` — the attribution keys on the
    // covering acu's `affiliate_user_id`, which can be any affiliate, but
    // the /creators surface only reports CREATORS (same `cu.role =
    // 'creator'` gate the existing `getAllCreatorsLifetimePnl` applies).
    // Non-creator affiliate ids are therefore absent from the lookup and
    // skipped below. Only ids with attributed activity are looked up, so
    // the query stays small regardless of the total creator count.
    const ids = [...byId.keys()];
    const users = await probeDb.user.findMany({
      where: { id: { in: ids }, role: "creator" },
      select: { id: true, username: true, image: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    // Roster-wide GGR legs — accumulated from the SAME per-creator
    // components, gated to `role = 'creator'` ids (the `if (!u) continue`
    // skip below), so the cohort breakdown sums exactly the same set the
    // tile's `totalGgr` does. `e.wager` is the ledger pack/battle stake
    // (upgrader is a separate `e.upgraderWager` slice); `e.ledgerGamingPayout`
    // is the ledger battle-refund cash leg. No extra query — pure in-loop
    // summation over the already-fetched rows.
    const legs: CohortGgrLegs = {
      packBattleWager: 0,
      upgraderWager: 0,
      inventoryPayout: 0,
      battleRefundLedger: 0,
      upgraderPayout: 0,
      wagersTotal: 0,
      payoutsTotal: 0,
    };

    let totalGgr = 0;
    const byCreator: CreatorNetGgrRow[] = [];
    for (const [creatorUserId, e] of byId) {
      const u = userById.get(creatorUserId);
      // Drop attributed ids that aren't `role = 'creator'` (non-creator
      // affiliates) — not part of the /creators surface.
      if (!u) continue;
      const wager = e.wager + e.upgraderWager;
      const gamingPayout = gamingPayoutTotal({
        inventoryPayout: e.inventoryPayout,
        battleRefund: e.ledgerGamingPayout + e.upgraderPayout,
      });
      const ggr = ggrFormula({ wager, gamingPayout });
      // Fold this creator's legs into the cohort breakdown (creator-gated,
      // same as the row push below).
      legs.packBattleWager += e.wager;
      legs.upgraderWager += e.upgraderWager;
      legs.inventoryPayout += e.inventoryPayout;
      legs.battleRefundLedger += e.ledgerGamingPayout;
      legs.upgraderPayout += e.upgraderPayout;
      byCreator.push({
        creatorUserId,
        username: u.username,
        image: u.image,
        ggr,
        wager,
        gamingPayout,
        inventoryPayout: e.inventoryPayout,
        ledgerGamingPayout: e.ledgerGamingPayout,
        upgraderWager: e.upgraderWager,
        upgraderPayout: e.upgraderPayout,
      });
      totalGgr += ggr;
    }

    // Derive the bucket totals from the accumulated legs. These mirror
    // the dashboard's `wagersTotal` / `payoutsTotal`, so
    // `wagersTotal − payoutsTotal === totalGgr` holds by construction
    // (each is the cohort sum of the same per-creator legs `totalGgr`
    // already sums).
    legs.wagersTotal = legs.packBattleWager + legs.upgraderWager;
    legs.payoutsTotal =
      legs.inventoryPayout + legs.battleRefundLedger + legs.upgraderPayout;

    // GGR descending — biggest house win first.
    byCreator.sort((a, b) => b.ggr - a.ggr);

    return { period, totalGgr, legs, byCreator };
  });
});
