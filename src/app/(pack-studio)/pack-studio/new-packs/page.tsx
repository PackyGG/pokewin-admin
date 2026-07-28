import { Suspense } from "react";
import { CheckCircle2, Clock3, PackageOpen, Rocket } from "lucide-react";

import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOwner } from "@/lib/owners";
import { safeQuery } from "@/lib/errors/safe-query";
import { listPackCreationRequests } from "@/lib/packs/build-requests";
import { PackRequestReviewList } from "./review-list";

export const metadata = { title: "Pack Approval Queue" };

const QUERY_TIMEOUT_MS = 10_000;

export default async function NewPacksPage() {
  await requireOwner();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={PackageOpen}
          accent="purple"
          title="Pack Approval Queue"
          subtitle="The final owner gate before a Pack Builder request can go live."
        />
      </PageHero>

      <Suspense fallback={<QueueSkeleton />}>
        <QueueBody />
      </Suspense>
    </div>
  );
}

async function QueueBody() {
  const { data: requests } = await safeQuery(
    () => listPackCreationRequests(100),
    [],
    "pack-studio.new-packs",
    QUERY_TIMEOUT_MS,
  );
  const approvalRequests = requests.filter((request) => request.requestedActive);
  const pending = approvalRequests.filter((request) => request.status === "pending");
  const approved = approvalRequests.filter((request) => request.status === "approved");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Awaiting approval"
          value={String(pending.length)}
          sub="owner decision required"
          icon={Clock3}
          accent="amber"
        />
        <KpiTile
          label="Live requests"
          value={String(approvalRequests.length)}
          sub="in the latest 100 requests"
          icon={Rocket}
          accent="rose"
        />
        <KpiTile
          label="Approved"
          value={String(approved.length)}
          sub="in the latest 100 requests"
          icon={CheckCircle2}
          accent="emerald"
        />
      </div>

      <section className="space-y-3">
        <SectionHeading icon={PackageOpen} title="Approval queue" />
        <p className="text-sm text-muted-foreground">
          Only live requests need approval. Saved inactive builds stay on the
          separate Saved Builds page until a builder submits them here.
        </p>
        <PackRequestReviewList
          requests={approvalRequests.map((request) => ({
            id: request.id,
            status: request.status,
            requesterUsername: request.requesterUsername,
            reviewerUsername: request.reviewerUsername,
            name: request.name,
            slug: request.slug,
            requestedActive: request.requestedActive,
            imageUrl: request.requestPayload.imageUrl ?? null,
            price: request.requestPayload.price,
            cardCount: request.requestPayload.cards.length,
            difficulty: request.requestPayload.difficulty ?? 0,
            previewEdge: request.previewEdge,
            previewWinRate: request.previewWinRate,
            createdPackId: request.createdPackId,
            createdAt: request.createdAt,
            reviewedAt: request.reviewedAt,
          }))}
        />
      </section>
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    </div>
  );
}
