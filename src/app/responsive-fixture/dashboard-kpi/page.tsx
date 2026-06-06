import { notFound } from "next/navigation";
import { DashboardKpiFixtureClient } from "./fixture-client";

/**
 * DEV-ONLY rendering fixture for the dashboard KPI section.
 *
 * Why this exists
 * ───────────────
 * The real /dashboard page assembles its KPI strip from
 * `getDashboardKpiStats` (+ the GGR breakdown legs), a heavy aggregate
 * against the MAIN game DB. On any environment whose local main DB is
 * behind / stale (the standard case here — see CLAUDE.md "stale local
 * Game-DB" gotcha) that aggregate throws and the page degrades, so the KPI
 * markup never renders and there is nothing to eyeball.
 *
 * This route renders the ACTUAL <DashboardKpiSection> component (the exact
 * file carrying the GGR sub-chip row + the Wager tile) with a static,
 * representative fixture, so the relabelled "Net wager" chip, its exclusion
 * hint, and the side-by-side gross "Total" wager can be verified in the
 * browser independently of the main-DB state. It is NOT a reimplementation
 * — it imports and renders the production component.
 *
 * Safety
 * ──────
 * Returns 404 in production (`NODE_ENV === "production"`), so it can never
 * be reached by a real admin. (Folder is NOT underscore-prefixed because
 * App Router treats `_folders` as private/non-routable.) It deliberately
 * lives OUTSIDE the (admin) route group so it doesn't require a page-access
 * grant or the full shell — the chip row's layout + copy are properties of
 * the component markup itself, which renders here inside the same
 * content-region padding the real admin shell uses.
 */

export const dynamic = "force-dynamic";

export default function ResponsiveDashboardKpiFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  // Mirror the admin shell's scrollable content region padding so the KPI
  // strip is measured in the same horizontal space it occupies in prod.
  return (
    <div className="min-h-screen bg-background">
      <div className="min-w-0 p-3 sm:p-4 md:p-6">
        <DashboardKpiFixtureClient />
      </div>
    </div>
  );
}
