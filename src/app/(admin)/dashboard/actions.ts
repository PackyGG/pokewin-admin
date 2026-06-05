"use server";

import { requirePageAccess } from "@/lib/dal";
import { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";

/**
 * Server action backing the "lifetime" toggle on the PnL KPI tile
 * (<PnlStatCard>) on /dashboard.
 *
 * The lifetime realized-P&L snapshot is the single heaviest query in the
 * codebase, so it is NO LONGER computed eagerly on every dashboard render.
 * The tile defaults to the cheap period (windowed) value and calls this
 * action only when the admin clicks the "lifetime" toggle — so a cold 24h
 * dashboard load never pays for the lifetime scan.
 *
 * SECURITY: gated by the SAME page-access guard the dashboard page itself
 * uses (`requirePageAccess("/dashboard")` — see dashboard/page.tsx:90), so
 * this never leaks the lifetime P&L to a caller who can't already see the
 * dashboard. `getRealizedPnlSnapshot` keeps its own 5-min `unstable_cache`,
 * so this action does not duplicate caching.
 */
export async function getLifetimePnlAction(): Promise<number> {
  await requirePageAccess("/dashboard");
  const snapshot = await getRealizedPnlSnapshot();
  return snapshot.pnl;
}
