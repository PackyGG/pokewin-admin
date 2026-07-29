import { Suspense } from "react";
import { ClipboardList, Layers3, PackageOpen, UserRound } from "lucide-react";
import { unstable_cache } from "next/cache";

import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { safeQuery } from "@/lib/errors/safe-query";
import { sessionHasRole } from "@/lib/dal";
import { isOwner } from "@/lib/owners";
import { listPackBuildDrafts } from "@/lib/packs/build-requests";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import {
  BuildDraftsList,
  type PackBuildDraftItem,
} from "./build-drafts-list";

export const metadata = { title: "Saved Pack Builds" };

const getCachedBuildDrafts = unstable_cache(
  (requestedBy: string | null) =>
    listPackBuildDrafts({
      limit: 100,
      requestedBy: requestedBy ?? undefined,
    }),
  ["pack-build-drafts.v2"],
  { revalidate: 30, tags: ["pack-build-drafts"] },
);

export default async function PackBuildDraftsPage() {
  const session = await requirePackStudioPageAccess();
  const canManageAll =
    isOwner(session) || sessionHasRole(session, "admin");
  const requestedBy = canManageAll ? null : session.userId;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense fallback={<BuildDraftsSkeleton />}>
        <BuildDraftsBody requestedBy={requestedBy} />
      </Suspense>
    </div>
  );
}

async function BuildDraftsBody({
  requestedBy,
}: {
  requestedBy: string | null;
}) {
  const { data: drafts } = await safeQuery(
    () => getCachedBuildDrafts(requestedBy),
    [],
    "pack-studio.builder-drafts",
    10_000,
  );
  const items: PackBuildDraftItem[] = drafts.map((draft) => ({
    id: draft.id,
    requesterUsername: draft.requesterUsername,
    name: draft.name,
    slug: draft.slug,
    imageUrl: draft.requestPayload.imageUrl ?? null,
    price: draft.requestPayload.price,
    cardCount: draft.requestPayload.cards.length,
    difficulty: draft.requestPayload.difficulty ?? 0,
    previewEdge: draft.previewEdge,
    previewWinRate: draft.previewWinRate,
    createdAt: draft.createdAt,
  }));
  const builderCount = new Set(items.map((draft) => draft.requesterUsername)).size;
  const cardCount = items.reduce((sum, draft) => sum + draft.cardCount, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Saved builds"
          value={String(items.length)}
          sub="no approval required"
          icon={PackageOpen}
          accent="blue"
        />
        <KpiTile
          label="Cards staged"
          value={String(cardCount)}
          sub="across saved builds"
          icon={Layers3}
          accent="purple"
        />
        <KpiTile
          label="Builders"
          value={String(builderCount)}
          sub="with saved drafts"
          icon={UserRound}
          accent="cyan"
        />
      </div>

      <section className="space-y-3">
        <SectionHeading icon={ClipboardList} title="Saved pack builds" />
        <p className="text-sm text-muted-foreground">
          Saving here only writes the ADMIN staging row. Request live approval
          when the build has an image and is ready for an owner decision.
        </p>
        <BuildDraftsList drafts={items} />
      </section>
    </div>
  );
}

function BuildDraftsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  );
}
