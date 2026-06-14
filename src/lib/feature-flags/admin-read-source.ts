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
