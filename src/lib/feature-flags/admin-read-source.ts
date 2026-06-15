import "server-only";

import { getCachedConfig } from "@/lib/edge-config";
import { isClickHouseEnabled } from "@/lib/clickhouse/client";

/**
 * Per-surface admin read-source switch — controls where a given admin read
 * gets its data, with no-deploy flips via Edge Config.
 *
 *   • "off"        → Postgres only (default; today's behavior).
 *   • "comparison" → run BOTH paths, serve Postgres, log drift (validation).
 *   • "clickhouse" → ClickHouse is the SOLE read path. On CH failure the caller
 *                    degrades to cached/error — it MUST NOT silently re-run the
 *                    heavy Postgres aggregate (that re-overloads prod).
 *
 * Resolution precedence (first match wins):
 *   0. HARD SAFETY  ClickHouse dormant (no creds) ⇒ "off"  (checked FIRST, below)
 *   1. Env override  ADMIN_READ_SOURCE__<SURFACE>  (e.g. ADMIN_READ_SOURCE__DASHBOARD_TODAY)
 *   2. Edge Config   admin-read-source:<surface>
 *   3. Edge Config   admin-read-source:__default
 *   4. Hardcoded cutover set  CUTOVER_DEFAULT_CLICKHOUSE  ⇒ "clickhouse"
 *   5. "off"
 *
 * HARD SAFETY: if ClickHouse is dormant (no creds), this ALWAYS returns "off",
 * so a surface can never be put in comparison/clickhouse without a live client —
 * keeping Phase 0 a true no-op until creds + an explicit flip are in place. This
 * guard runs BEFORE the cutover set, so the committed `clickhouse` defaults
 * below stay dormant until a live client exists.
 *
 * PHASE 2F CUTOVER: a surface listed in `CUTOVER_DEFAULT_CLICKHOUSE` ships with
 * its committed CODE default = "clickhouse" (step 4), so a proven surface serves
 * from ClickHouse with no deploy needed — while env (step 1) and Edge Config
 * (steps 2–3) still OVERRIDE it, preserving instant rollback (set
 * `admin-read-source:<surface>` = "off"/"comparison", or the env var, to pull a
 * surface back to Postgres without a deploy).
 */
export type AdminReadMode = "off" | "comparison" | "clickhouse";

/**
 * Phase 2B surface flag keys for the /rewards/analytics CH twins (one per
 * rendered leg). Listed here for discoverability; like every other surface key
 * (e.g. `insights_rakeback_*`, `xp_sales`) they carry NO registration cost —
 * `getAdminReadMode` resolves any unset key through the precedence chain whose
 * terminal default is `"off"`, so each defaults to Postgres-only until an
 * explicit env/Edge-Config flip to `"comparison"`. NEVER flipped to
 * `"clickhouse"` in Phase 2B.
 */
export const REWARDS_ANALYTICS_SURFACE_KEYS = [
  "rewards_analytics_overview",
  "rewards_analytics_category",
  "rewards_analytics_leaderboards",
  "rewards_analytics_extras",
] as const;

/**
 * Phase 2B surface flag key for the /analytics?tab=pure-pnl "Pack & Battle Pure
 * P&L" panel CH twin (`getPackBattlePurePnl`). Like every other surface key it
 * carries NO registration cost — `getAdminReadMode` resolves it through the
 * precedence chain whose terminal default is `"off"`, so it stays Postgres-only
 * until an explicit env/Edge-Config flip to `"comparison"`. NEVER flipped to
 * `"clickhouse"` in Phase 2B.
 */
export const ANALYTICS_PURE_PNL_SURFACE_KEY = "pure_pnl";

/**
 * Phase 2B surface flag keys for the /analytics Top-performers + Revenue tab CH
 * twins: `analytics_top` (all six leaderboards — depositors / wagerers / losers
 * / winners / creators / countries), `analytics_revenue` (the revenue-by-source
 * breakdown), and `analytics_revenue_withdrawals` (the withdrawn-coins card).
 * Listed here for discoverability only; like every other surface key they carry
 * NO registration cost — `getAdminReadMode` resolves any unset key through the
 * precedence chain whose terminal default is `"off"`, so each defaults to
 * Postgres-only until an explicit env/Edge-Config flip to `"comparison"`. NEVER
 * flipped to `"clickhouse"` in Phase 2B.
 */
export const ANALYTICS_TOP_REVENUE_SURFACE_KEYS = [
  "analytics_top",
  "analytics_revenue",
  "analytics_revenue_withdrawals",
] as const;

/**
 * Phase 2B surface flag keys for the /analytics OVERVIEW + PACKS tab CH twins —
 * the last two unmigrated /analytics tabs: `analytics_overview` (the full
 * `getAnalyticsData` headline + breakdown + battle/pack aggregates + daily
 * series), and the three PACKS-tab legs `analytics_packs_profitability`
 * (`getPackProfitability`), `analytics_packs_top24h` (`getTopOpenedPacks24h`)
 * and `analytics_packs_stats` (`getPackAndBattleStats`). Listed here for
 * discoverability only; like every other surface key they carry NO registration
 * cost — `getAdminReadMode` resolves any unset key through the precedence chain
 * whose terminal default is `"off"`, so each defaults to Postgres-only until an
 * explicit env/Edge-Config flip to `"comparison"`. NEVER flipped to
 * `"clickhouse"` in Phase 2B.
 */
export const ANALYTICS_OVERVIEW_PACKS_SURFACE_KEYS = [
  "analytics_overview",
  "analytics_packs_profitability",
  "analytics_packs_top24h",
  "analytics_packs_stats",
] as const;

/**
 * Phase 2B surface flag keys for the /dashboard remaining daily-leg CH twins
 * (one per leg). Listed here for discoverability only; like every other
 * surface key they carry NO registration cost — `getAdminReadMode` resolves any
 * unset key through the precedence chain whose terminal default is `"off"`, so
 * each defaults to Postgres-only until an explicit env/Edge-Config flip to
 * `"comparison"`. NEVER flipped to `"clickhouse"` in Phase 2B.
 */
export const DASHBOARD_DAILY_LEGS_SURFACE_KEYS = [
  "dashboard_creator_costs_today",
  "dashboard_affiliate_referred_pnl_today",
  "dashboard_chat_messages_today",
  "dashboard_net_holdings_movers",
] as const;

/**
 * Phase 2B surface flag key for the "Motha giveaways" forecast-baseline CH twin
 * (`getMothaGiveawayOverview`, the anchor of `/insights/forecast?reward=motha`).
 * Like every other surface key it carries NO registration cost —
 * `getAdminReadMode` resolves any unset key through the precedence chain whose
 * terminal default is `"off"`, so it stays Postgres-only until an explicit
 * env/Edge-Config flip to `"comparison"`. NEVER flipped to `"clickhouse"` in
 * Phase 2B.
 */
export const INSIGHTS_MOTHA_SURFACE_KEY = "insights_motha_overview";

/**
 * Phase 2B surface flag key for the /insights/rewards/raffle forecast baseline
 * CH twin (`getRaffleForecastBaseline` — the raffle reward's REAL baseline, with
 * prize cost RECONSTRUCTED from each raffle's `prizes` JSON valued at live
 * pack/card prices). Listed here for discoverability only; like every other
 * surface key it carries NO registration cost — `getAdminReadMode` resolves it
 * through the precedence chain whose terminal default is `"off"`, so it stays
 * Postgres-only until an explicit env/Edge-Config flip to `"comparison"`. NEVER
 * flipped to `"clickhouse"` in Phase 2B.
 */
export const INSIGHTS_RAFFLE_BASELINE_SURFACE_KEY = "insights_raffle_baseline";

/**
 * Phase 2B surface flag keys for the /analytics retention + LTV tab CH twins
 * (`getRetentionCurve` / `getCreatorLtv`). Listed here for discoverability
 * only; like every other surface key they carry NO registration cost —
 * `getAdminReadMode` resolves any unset key through the precedence chain whose
 * terminal default is `"off"`, so each defaults to Postgres-only until an
 * explicit env/Edge-Config flip to `"comparison"`. NEVER flipped to
 * `"clickhouse"` in Phase 2B.
 */
export const ANALYTICS_RETENTION_LTV_SURFACE_KEYS = [
  "analytics_retention",
  "analytics_ltv",
] as const;

/**
 * Phase 2B surface flag keys for the /creators/[userId] detail-page CH twins:
 * `creators_detail_aggregates` (the `getCreatorDetail` KPI/funnel/payouts
 * snapshot) and `creators_detail_pnl` (the `getCreatorPnl` per-window + lifetime
 * House P&L headline). Listed here for discoverability only; like every other
 * surface key they carry NO registration cost — `getAdminReadMode` resolves any
 * unset key through the precedence chain whose terminal default is `"off"`, so
 * each defaults to Postgres-only until an explicit env/Edge-Config flip to
 * `"comparison"`. NEVER flipped to `"clickhouse"` in Phase 2B.
 */
export const CREATORS_DETAIL_SURFACE_KEYS = [
  "creators_detail_aggregates",
  "creators_detail_pnl",
] as const;

/**
 * PHASE 2F CUTOVER SET — surfaces whose committed CODE default is "clickhouse".
 *
 * A surface key in this set resolves to "clickhouse" via precedence step 4
 * (after env + both Edge-Config lookups, before the terminal "off"), so a
 * proven surface serves from ClickHouse by default with no deploy — while the
 * dormant-client guard (step 0) still forces "off" without a live client, and
 * env / Edge Config still override for instant rollback.
 *
 * ONLY add a surface here AFTER its CH twin is proven cent/count-exact against
 * Postgres (parity harness, TZ=UTC, run twice) AND a logged-in render check
 * confirms the page serves correctly from ClickHouse. The four below are the
 * Phase 2A dashboard surfaces (re-confirmed cent/count-exact before this flip).
 *
 * Note on blast radius: a key here cuts over EVERY consumer of that surface's
 * canonical read (the resolver is keyed on the surface, not the page). The four
 * below are wired at their canonical computation functions, so:
 *   • dashboard_trend_series / dashboard_cashflow are dashboard-only reads.
 *   • dashboard_headline_ggr (getWindowMetrics) and dashboard_realized_pnl_lifetime
 *     (getRealizedPnlSnapshot) are ALSO read by /ggr, /analytics, and the
 *     /insights cost-breakdown + real-numbers pages — those consumers cut over
 *     too. Parity is cent/count-exact for these reads, and any single surface
 *     rolls back instantly via Edge Config.
 */
const CUTOVER_DEFAULT_CLICKHOUSE: ReadonlySet<string> = new Set([
  "dashboard_headline_ggr",
  "dashboard_trend_series",
  "dashboard_realized_pnl_lifetime",
  "dashboard_cashflow",
]);

const VALID: readonly AdminReadMode[] = ["off", "comparison", "clickhouse"];

function coerce(value: unknown): AdminReadMode | null {
  return typeof value === "string" && (VALID as readonly string[]).includes(value)
    ? (value as AdminReadMode)
    : null;
}

function envKeyFor(surfaceKey: string): string {
  return `ADMIN_READ_SOURCE__${surfaceKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export async function getAdminReadMode(
  surfaceKey: string,
): Promise<AdminReadMode> {
  // No client → never anything but Postgres. This is the Phase-0 no-op guard.
  if (!isClickHouseEnabled()) return "off";

  const envOverride = coerce(process.env[envKeyFor(surfaceKey)]?.trim());
  if (envOverride) return envOverride;

  const perSurface = coerce(
    await getCachedConfig<string>(`admin-read-source:${surfaceKey}`),
  );
  if (perSurface) return perSurface;

  const globalDefault = coerce(
    await getCachedConfig<string>("admin-read-source:__default"),
  );
  if (globalDefault) return globalDefault;

  // Phase 2F: committed code default = "clickhouse" for proven, cut-over
  // surfaces. Runs AFTER env + both Edge-Config lookups (so any of them still
  // override → instant rollback) and AFTER the dormant-client guard at the top
  // (so this never forces a CH read without a live client).
  if (CUTOVER_DEFAULT_CLICKHOUSE.has(surfaceKey)) return "clickhouse";

  return "off";
}
