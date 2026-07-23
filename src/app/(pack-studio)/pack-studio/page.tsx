import { Suspense } from "react";
import { LayoutDashboard } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { sessionIsOwner } from "@/lib/dal";
import { PackStudioOverviewContent } from "./_components/overview-content";
import { PackStudioUserAccessSection } from "./_components/pack-studio-user-access-section";

/**
 * Pack Studio — Overview. Read-only risk & compliance dashboard.
 *
 * Shell-first: the shell paints immediately, then the heavy snapshot-derived
 * KPIs / alerts / histogram stream in behind a <Suspense> boundary whose
 * fallback is the same skeleton `loading.tsx` renders.
 *
 * PERF: this used to `await readPackSystemConfig()` here to label a ramp-phase
 * badge on the hero — an ADMIN round-trip on the critical path before ANY
 * pixel. It bought nothing: the de-boxed `PageHeroIdentity` no longer renders
 * `icon` / `title` / `subtitle` / `badges` at all (it returns null without a
 * `back` or `action`), so the awaited value was formatted and then dropped.
 * The ramp phase is still shown — in the streamed "Ramp phase" panel, off the
 * cached base read that was already loading it.
 */
export default async function PackStudioOverviewPage() {
  const session = await requirePackStudioPageAccess();
  const isOwner = sessionIsOwner(session);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={LayoutDashboard}
          accent="purple"
          title="Pack Studio"
          subtitle="Design, audit, and tune packs and cards in one workspace."
        />
      </PageHero>

      {/* Owner-only per-username access toggle. Lets the owner grant or
          revoke Pack Studio access for a specific admin (e.g. demee) in one
          click without touching their role. Hidden for everyone else (the
          server action behind it is also owner-gated). */}
      {isOwner && (
        <Suspense fallback={<UserAccessFallback />}>
          <PackStudioUserAccessSection />
        </Suspense>
      )}

      <Suspense fallback={<OverviewFallback />}>
        <PackStudioOverviewContent />
      </Suspense>
    </div>
  );
}

/** Skeleton for the owner-only access card while its ADMIN-DB reads resolve. */
function UserAccessFallback() {
  return (
    <div className="space-y-3">
      <SectionHeadingSkeleton titleWidth={180} />
      <Skeleton className="h-[200px] rounded-2xl" />
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
