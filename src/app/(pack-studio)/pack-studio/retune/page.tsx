import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { getDefaultRouteForRoles } from "@/lib/admin-roles";
import { getUserPermissions, sessionRoles } from "@/lib/dal";

import { getRetuneRailRows } from "./_queries/rail";
import { getTunedPackCount } from "./_queries/tuned-count";
import { RetuneWorkspace } from "./_workspace/workspace";
import { WorkspaceSkeleton } from "./loading";

/**
 * Retune V2 — ONE workspace replacing the four-brain swipe queue: a left
 * rail of every active pack seeded from the 60s-cached ADMIN risk snapshot
 * (NO 183-pack solver sweep — the old page's eager `planAllRetunes()` dry-run
 * died here), and a right workspace where the selected pack's staged pool
 * feeds exactly one server plan call (`planPackTune`) whose result is the
 * ONLY source of every number on screen AND the EXACT artifact the Push
 * button writes (pinned by `approvedPriceAfter` tolerance-0 +
 * `approvedPoolFingerprint`, fail-closed server-side).
 *
 * Shell-first: the hero paints immediately; only the cheap rail seed streams
 * behind Suspense. Plans are computed on selection, single-pack — the sweep
 * budget that needed `maxDuration = 120` is gone.
 */
export const maxDuration = 30;

async function RailLoader({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Both cheap ADMIN reads run in parallel: the rail seed (risk snapshot) and
  // the persistent distinct-tuned-pack count.
  const [{ rows, error }, tunedCount] = await Promise.all([
    getRetuneRailRows(),
    getTunedPackCount(),
  ]);
  const pack = typeof sp.pack === "string" ? sp.pack : null;
  const bulk = typeof sp.bulk === "string" ? sp.bulk : null;
  return (
    <FadeIn>
      <RetuneWorkspace
        rows={rows}
        railError={error}
        tunedCount={tunedCount}
        initialPackId={pack}
        initialBulk={bulk}
      />
    </FadeIn>
  );
}

export default async function PackRetuneWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePackStudioPageAccess();

  // Operator-only surface: a non-operator Pack-Studio viewer is bounced to
  // their landing route (the same contract the re-price / doctor write tools
  // use). Owners always pass; the hard-coded Pack-Studio retune operator
  // allowlist (`isPackStudioRetuneOperator`) also passes.
  if (!isPackStudioRetuneOperator(session)) {
    const allowedPages = await getUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(sessionRoles(session), allowedPages));
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Sparkles}
          accent="purple"
          title="Retune Workspace"
          subtitle="Pick a pack, review its plan, push it live — what you see is exactly what writes."
        />
      </PageHero>

      <Suspense fallback={<WorkspaceSkeleton />}>
        <RailLoader searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
