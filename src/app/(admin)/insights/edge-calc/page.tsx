import { Suspense } from "react";
import { Sigma } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getPackEdgeRows,
  getUpgraderEdgeByTarget,
  getUpgraderPoolStats,
} from "@/lib/queries/insights-edge-calc";

import { EdgeCalcTabNav } from "./tab-nav";
import { parseEdgeCalcTab } from "./types";
import { PacksTab } from "./packs-tab";
import { UpgraderTab } from "./upgrader-tab";
import { ScenarioBuilder } from "./scenario-builder";
import { BonusStackTab } from "./bonus-stack";

export const metadata = { title: "Edge Calc" };

/**
 * /insights/edge-calc — theoretical EV / RTP / house-edge calculator.
 *
 * Four tabs (chip-style nav in `tab-nav.tsx`):
 *   • Packs    — table of every pack with theoretical RTP next to
 *                empirical RTP (drift column = the read)
 *   • Upgrader — per-target-multiplier edge from upgrader_games + PF
 *                metadata, plus a bet × multiplier EV matrix
 *   • Scenario — interactive form layering pack pick / repetitions /
 *                borrow / bonus / rakeback / deposit, producing live
 *                user + house P&L projections
 *   • Bonus    — bonus-stack ROI calculator with break-even wager-×
 *                ladder
 *
 * Read-only against Main DB. Per CLAUDE.md the page is gated by
 * `requirePageAccess("/insights/edge-calc")`, which the admin-pages
 * whitelist below the import block keeps in sync with the role editor.
 */
export default async function EdgeCalcPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/edge-calc");
  const params = await searchParams;
  const tab = parseEdgeCalcTab(params.tab);

  // Pack EV powers three of the four tabs (Packs, Scenario, Bonus) so
  // we fetch once at the page level and pass it down. Upgrader-only
  // data is loaded lazily inside the Suspense per-tab to avoid the
  // backend API roundtrip on tabs that don't need it.
  const packRows = await getPackEdgeRows();
  // Lightweight projection of the pack rows for the interactive tabs
  // (scenario builder + bonus stack only need a handful of fields).
  const packOptions = packRows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    priceUsd: p.priceUsd,
    cardsPerOpen: p.cardsPerOpen,
    theoreticalRtp: p.theoreticalRtp,
    expectedCardValue: p.expectedCardValue,
    expectedPayoutPerOpen: p.expectedPayoutPerOpen,
  }));

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Sigma}
          accent="purple"
          title="Edge Calc"
          subtitle="Theoretical EV, RTP, and house-edge math for packs, upgrader, and reward stacks."
        />
      </PageHero>

      <EdgeCalcTabNav />

      {tab === "packs" && <PacksTab rows={packRows} />}
      {tab === "upgrader" && (
        <Suspense
          fallback={
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          }
        >
          <UpgraderTabAsync />
        </Suspense>
      )}
      {tab === "scenario" && <ScenarioBuilder packs={packOptions} />}
      {tab === "bonus" && <BonusStackTab packs={packOptions} />}
    </div>
  );
}

/**
 * Async data island for the Upgrader tab. Splits the upgrader bucket
 * roll-up + the backend pool fetch off the main page render so the
 * other three tabs don't pay for the backend API roundtrip.
 */
async function UpgraderTabAsync() {
  const [rows, pool] = await Promise.all([
    getUpgraderEdgeByTarget(),
    getUpgraderPoolStats(),
  ]);
  return <UpgraderTab rows={rows} pool={pool} />;
}
