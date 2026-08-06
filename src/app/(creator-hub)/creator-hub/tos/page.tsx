import { Suspense } from "react";
import { History, ScrollText } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getPublishedCreatorAgreementTerms,
  listCreatorAgreementTermVersions,
} from "@/lib/creator-agreement-terms";
import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { formatDateTime } from "@/lib/utils/format";

import { CreatorTermsEditor } from "./terms-editor";

export const metadata = { title: "Creator Terms · Creator Hub" };

export default async function CreatorTermsPage() {
  await requireCreatorHubPageAccess();

  // Shell-first: the section heading paints immediately and both reads resolve
  // behind a boundary whose fallback matches this route's loading.tsx.
  return (
    <div className="space-y-6">
      <SectionHeading icon={ScrollText} title="Creator agreement terms" />
      <Suspense fallback={<CreatorTermsBodySkeleton />}>
        <CreatorTermsBody />
      </Suspense>
    </div>
  );
}

async function CreatorTermsBody() {
  const [published, versions] = await Promise.all([
    getPublishedCreatorAgreementTerms(),
    listCreatorAgreementTermVersions(),
  ]);

  return (
    <>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">Terms shown before Discord approval</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each numbered line is snapshotted onto a request. Publishing a new version never changes an agreement already sent.
            </p>
          </div>
          {published ? (
            <Badge variant="outline">Version {published.version}</Badge>
          ) : (
            <Badge variant="outline">Not published</Badge>
          )}
        </div>
        <CreatorTermsEditor initialLines={published?.lines ?? []} />
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <History className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">Published versions</h2>
        </div>
        {versions.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No terms have been published yet.</p>
        ) : (
          <div className="divide-y">
            {versions.map((version) => (
              <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div>
                  <span className="font-medium">Version {version.version}</span>
                  <span className="ml-2 text-muted-foreground">{version.lineCount} lines</span>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div>{formatDateTime(version.publishedAt)}</div>
                  <div className="font-mono">{version.checksum.slice(0, 12)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/** Same two cards the body renders, in placeholder form. Kept in sync with
 *  `tos/loading.tsx` so the cold-nav and in-page states are identical. */
function CreatorTermsBodySkeleton() {
  return (
    <>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-2">
            <Skeleton className="h-5 w-72 rounded" />
            <Skeleton className="h-4 w-96 max-w-full rounded" />
          </div>
          <Skeleton className="h-6 w-24 rounded-md" />
        </div>
        <Skeleton className="h-56 w-full rounded-lg" />
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-5 w-40 rounded" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <Skeleton className="h-4 w-48 rounded" />
              <div className="space-y-1.5 text-right">
                <Skeleton className="ml-auto h-3 w-32 rounded" />
                <Skeleton className="ml-auto h-3 w-24 rounded" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
