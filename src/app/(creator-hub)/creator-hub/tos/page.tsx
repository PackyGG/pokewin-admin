import { History, ScrollText } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
  const [published, versions] = await Promise.all([
    getPublishedCreatorAgreementTerms(),
    listCreatorAgreementTermVersions(),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeading icon={ScrollText} title="Creator agreement terms" />
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
    </div>
  );
}
