"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getGgrTopContributors,
  parseDashboardPeriod,
  type GgrTopContributorRow,
} from "@/lib/queries/dashboard";

/**
 * Server action backing the "Show top contributors" expander inside
 * the GGR breakdown popover on /dashboard.
 *
 * The breakdown popover loads its per-type rows up-front (cheap, one
 * GROUP BY type sweep) but the per-user contributor list is heavier
 * (GROUP BY user_id over the same window), so it lives behind a click
 * — this action runs only when the admin opens the expander.
 *
 * `periodParam` is a free-string from the client; sanitized via
 * `parseDashboardPeriod` so an unknown / tampered value falls back to
 * the default period rather than throwing. `limit` is clamped inside
 * the query helper itself, so the value here is advisory.
 */
export async function fetchGgrTopContributors(
  periodParam: string,
  limit = 10,
): Promise<GgrTopContributorRow[]> {
  await requirePageAccess("/dashboard");
  const period = parseDashboardPeriod(periodParam);
  return getGgrTopContributors(period, limit);
}
