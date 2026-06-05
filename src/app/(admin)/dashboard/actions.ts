"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getGgrTopContributorsForKpiWindow,
  parseDashboardKpiWindow,
  type GgrTopContributorRow,
} from "@/lib/queries/dashboard";
import {
  buildKpiWindowPayload,
  type KpiWindowPayload,
} from "./kpi-window-data";

/**
 * Server action backing the per-box "24h" toggle on the dashboard's
 * headline KPI boxes.
 *
 * The dashboard DEFAULTS every KPI box to the CURRENT DAY (since 00:00
 * UTC) and renders that "today" payload eagerly. The rolling 24h window is
 * the secondary view, loaded LAZILY by this action only when the admin
 * flips a box to "24h" the first time (active-timeframe-only — the 24h
 * aggregate never runs on a cold dashboard render). The client caches the
 * returned payload so subsequent toggles are instant.
 *
 * `windowParam` is sanitized via `parseDashboardKpiWindow` so a
 * tampered/unknown value falls back to "today" rather than throwing.
 *
 * SECURITY: gated by the SAME page-access guard the dashboard page uses
 * (`requirePageAccess("/dashboard")`), so it never leaks KPI figures to a
 * caller who can't already see the dashboard.
 */
export async function getDashboardKpiStatsAction(
  windowParam: string,
): Promise<KpiWindowPayload> {
  await requirePageAccess("/dashboard");
  const window = parseDashboardKpiWindow(windowParam);
  return buildKpiWindowPayload(window);
}

/**
 * Server action backing the "Show top contributors" expander inside the
 * GGR breakdown popover when a KPI box is on the today/24h view.
 *
 * Mirrors `fetchGgrTopContributors` (the chip-enum path) but resolves the
 * window via `parseDashboardKpiWindow`, so the per-user GGR sweep runs
 * against the SAME today/24h window the admin is currently looking at.
 * Heavier per-user GROUP BY, so it stays lazy (only runs on expander open).
 */
export async function fetchGgrKpiTopContributors(
  windowParam: string,
  limit = 10,
): Promise<GgrTopContributorRow[]> {
  await requirePageAccess("/dashboard");
  const window = parseDashboardKpiWindow(windowParam);
  return getGgrTopContributorsForKpiWindow(window, limit);
}
