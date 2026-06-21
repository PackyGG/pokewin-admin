import { Suspense } from "react";
import { LayoutDashboard } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { PackStudioOverviewContent } from "./_components/overview-content";
import { readPackSystemConfig } from "./_lib/risk-config";

/**
 * Pack Studio — Overview. Read-only risk & compliance dashboard.
 *
 * Shell-first: the PageHero (with a ramp-phase badge sourced from the cheap
 * single-key `pack_system_config` admin read) paints immediately, then the
 * heavy snapshot-derived KPIs / alerts / histogram stream in behind a
 * <Suspense> boundary whose fallback reuses the route loading skeleton.
 */
export default async function PackStudioOverviewPage() {
  await requirePackStudioPageAccess();

  // Cheap single-row ADMIN read (admin_settings) — used only to label the
  // hero badge; the heavy overview read happens inside the Suspense child.
  const cfg = await readPackSystemConfig();
  const phaseLabel =
    typeof cfg?.phase === "string" && cfg.phase.length > 0 ? cfg.phase : null;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={LayoutDashboard}
          accent="purple"
          title="Pack Studio"
          subtitle="Design, audit, and tune packs and cards in one workspace."
          badges={
            <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2.5 py-0.5 text-xs font-medium text-purple-600 dark:text-purple-400">
              {phaseLabel ? `Ramp · ${phaseLabel}` : "Ramp"}
            </span>
          }
        />
      </PageHero>

      <Suspense fallback={<OverviewFallback />}>
        <PackStudioOverviewContent />
      </Suspense>
    </div>
  );
}

/**
 * Suspense fallback for the overview content (no hero — the page shell already
 * paints it). Mirrors the eventual layout: a 6-tile KPI strip, a two-up
 * ramp/chart row, and a compliance-alert grid.
 */
function OverviewFallback() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[200px] rounded-2xl" />
        <Skeleton className="h-[200px] rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} action />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
