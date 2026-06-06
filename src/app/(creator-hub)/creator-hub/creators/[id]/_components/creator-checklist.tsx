import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonBoundary } from "@/components/ux";

import { getCreatorChecklist } from "../_queries/onboarding-checklist-data";
import { OnboardingChecklistPanel } from "./onboarding-checklist-client";

/**
 * Per-creator Onboarding Checklist — full panel (server entry point).
 *
 * This is the self-contained component the right-rail dock mounts (the actual
 * dock wiring is a separate step): `<CreatorChecklist userId={creatorId} />`.
 * It takes ONLY the creator's user id and fetches its OWN data.
 *
 * Behaviour (owner spec):
 *   • LAZY — the data read runs inside its own Suspense boundary, so mounting
 *     the dock paints a skeleton immediately and never blocks the rest of the
 *     rail (active-surface-only / never-preload rule). The heavy AUTO lookups
 *     (deals / leaderboards / API key / socials / PFP) only run when this
 *     component is actually rendered.
 *   • AUTO-HIDES — once every item (auto + manual) is satisfied the server
 *     resolves `complete: true` and this renders NOTHING for that creator, on
 *     both surfaces. A transient AUTO-source miss is treated as `partial` and
 *     does NOT hide a not-yet-complete checklist.
 *
 * Only serializable data is passed to the client panel (no function props).
 * MAIN/prod game DB is read-only here; manual writes hit the ADMIN DB via the
 * gated server actions.
 */
export function CreatorChecklist({ userId }: { userId: string }) {
  return (
    <Suspense fallback={<CreatorChecklistSkeleton />}>
      <CreatorChecklistContent userId={userId} />
    </Suspense>
  );
}

async function CreatorChecklistContent({ userId }: { userId: string }) {
  const data = await getCreatorChecklist(userId);

  // Auto-hide: nothing to show once fully onboarded or not a new creator.
  if (!data || data.complete) return null;

  return <OnboardingChecklistPanel data={data} />;
}

function CreatorChecklistSkeleton() {
  return (
    <SkeletonBoundary
      className="overflow-hidden rounded-xl border border-primary/20 bg-card"
      label="Loading onboarding checklist…"
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <Skeleton className="size-8 rounded-lg" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-2.5 w-24" />
        </div>
        <Skeleton className="h-5 w-10 rounded-full" />
      </div>
      <div className="px-3.5 pb-2">
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <div className="space-y-1.5 px-2.5 pb-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    </SkeletonBoundary>
  );
}
