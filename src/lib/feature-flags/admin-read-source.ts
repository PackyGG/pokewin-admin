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
 *   1. Env override  ADMIN_READ_SOURCE__<SURFACE>  (e.g. ADMIN_READ_SOURCE__DASHBOARD_TODAY)
 *   2. Edge Config   admin-read-source:<surface>
 *   3. Edge Config   admin-read-source:__default
 *   4. "off"
 *
 * HARD SAFETY: if ClickHouse is dormant (no creds), this ALWAYS returns "off",
 * so a surface can never be put in comparison/clickhouse without a live client —
 * keeping Phase 0 a true no-op until creds + an explicit flip are in place.
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

  return "off";
}
