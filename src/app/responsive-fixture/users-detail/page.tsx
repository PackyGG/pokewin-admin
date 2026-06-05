import { notFound } from "next/navigation";
import { UserDetailFixtureClient } from "./fixture-client";

/**
 * DEV-ONLY rendering fixture for the responsive audit harness.
 *
 * Why this exists
 * ───────────────
 * The responsive harness (e2e/responsive/**) measures rendered geometry of
 * the REAL components. The one route the Wave 0 acceptance gate targets —
 * /users/[id] — assembles its hero from `getUserDetail`, a ~19-query
 * aggregate against the MAIN game DB. On any environment whose main DB is
 * behind the current Prisma schema (e.g. a local copy missing the
 * `user_battle_limits` table or the `upgrader_bet` enum value), that
 * aggregate throws and the page degrades to a "details failed to load"
 * banner — so the hero markup never renders and there is nothing for the
 * detector to measure.
 *
 * This route renders the ACTUAL `UserViewModern` component (the exact file
 * that carries the hand-rolled hero + KPI grid the audit targets) with a
 * static, representative fixture, so the harness can prove it catches the
 * real component's layout break independently of the main-DB schema. It is
 * NOT a reimplementation — it imports and renders the production component.
 *
 * Safety
 * ──────
 * Returns 404 in production (`NODE_ENV === "production"`), so it can never
 * be reached by a real admin. (Folder is NOT underscore-prefixed because
 * App Router treats `_folders` as private/non-routable.) It deliberately
 * lives OUTSIDE the (admin) route group so it doesn't require a page-access
 * grant or the full shell —
 * the hero's overlap is a property of the hero markup itself, which renders
 * here inside the same content-region padding the real admin shell uses.
 */

export const dynamic = "force-dynamic";

export default function ResponsiveUserDetailFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  // Mirror the admin shell's scrollable content region padding so the hero
  // is measured in the same horizontal space it occupies in production.
  return (
    <div className="min-h-screen bg-background">
      <div className="min-w-0 p-3 sm:p-4 md:p-6">
        <UserDetailFixtureClient />
      </div>
    </div>
  );
}
