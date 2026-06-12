import { notFound } from "next/navigation";
import { EdgePlanV2FixtureClient } from "./fixture-client";

/**
 * DEV-ONLY rendering fixture for the responsive audit harness.
 *
 * Why this exists
 * ───────────────
 * The responsive harness (e2e/responsive/**) measures rendered geometry of
 * the REAL Edge Plan 2.0 planner. The live route /insights/edge-plan-2
 * assembles its baseline from `getEdgePlanV2Baseline`, a stack of read-only
 * aggregates against the MAIN game DB (gaming legs, affiliate / raffle /
 * withdrawal / motha / upgrader reads). On any environment whose main DB is
 * behind the current Prisma schema (the local copy is the frozen DEV
 * snapshot — see CLAUDE.md "Stale local dev DB"), those aggregates degrade
 * to zeros and the planner renders an empty / sparse state, so the hero,
 * lever rail, charts, and the restored Raffle section never appear and there
 * is nothing for the detector to measure.
 *
 * This route renders the ACTUAL <EdgePlanV2Planner> (the exact client shell
 * that carries the v2.1 overhaul's hero, seven lever workspaces, charts,
 * shards and crediting-matrix sections) with a static, representative
 * `EdgePlanV2Baseline`, so the harness can prove it catches the real
 * component's layout across 320→1536 widths independently of the main-DB
 * schema. It is NOT a reimplementation — it imports and renders the
 * production component with the production type.
 *
 * The fixture is deliberately tuned to exercise every overhaul section at
 * the default ($0-delta) mount (see fixture-client.tsx):
 *   • a NEGATIVE net-edge-after-rewards scenario (reward cost > GGR) so the
 *     rose / amber net-edge paths render, plus a NEGATIVE measured
 *     (`canonical`) 30d block for the "Measured 30d" strip,
 *   • deterministic deposit-fee chip volumes (USDT exempt by default),
 *     raffle keep-slider cost, rain anchor, adjustment categories incl. the
 *     NULL "Not itemized" bucket, deposit-size + time-bonus histograms,
 *     daily-pack level gates/usage, and all 7 crediting-matrix sources,
 *   • a realistic affiliate commission / leaderboard split.
 *
 * Safety
 * ──────
 * Returns 404 in production (`NODE_ENV === "production"`), so it can never be
 * reached by a real admin. (Folder is NOT underscore-prefixed because App
 * Router treats `_folders` as private/non-routable.) It deliberately lives
 * OUTSIDE the (admin) route group so it doesn't require a page-access grant
 * or the full shell — the planner renders here inside the same
 * content-region padding the real admin shell uses.
 */

export const dynamic = "force-dynamic";

export default function ResponsiveEdgePlan2Fixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  // Mirror the admin shell's scrollable content region padding so the planner
  // is measured in the same horizontal space it occupies in production.
  return (
    <div className="min-h-screen bg-background">
      <div className="min-w-0 p-3 sm:p-4 md:p-6">
        <EdgePlanV2FixtureClient />
      </div>
    </div>
  );
}
