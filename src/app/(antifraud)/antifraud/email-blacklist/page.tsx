import { Suspense } from "react";
import { AlertTriangle, Ban, LockKeyhole } from "lucide-react";

import {
  FormCardSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import { listFiatEmailDomains } from "@/lib/antifraud/fiat-email-domains-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { PanelErrorBoundary } from "../_components/panel-error-boundary";
import { EmailBlacklistClient } from "./email-blacklist-client";

export const metadata = { title: "Email Blacklist · Antifraud" };

async function EmailBlacklistContent() {
  const result = await listFiatEmailDomains();
  const active = result.data.filter((rule) => rule.enabled);
  const affectedUsers = result.data.reduce(
    (total, rule) => total + rule.affectedUsers,
    0,
  );
  const pendingLocks = result.data.reduce(
    (total, rule) => total + rule.pendingLocks,
    0,
  );

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Active domains"
          value={String(active.length)}
          icon={Ban}
          accent="rose"
        />
        <KpiTile
          label="Affected users"
          value={String(affectedUsers)}
          icon={LockKeyhole}
          accent="orange"
        />
        <KpiTile
          label="Locks pending"
          value={String(pendingLocks)}
          icon={AlertTriangle}
          accent={pendingLocks > 0 ? "amber" : "emerald"}
        />
      </div>

      {(!result.configured || result.error) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!result.configured
            ? "The Antifraud monitor API is not configured, so blacklist changes are unavailable."
            : "The live blacklist could not be loaded. No empty state is being assumed."}
        </div>
      )}

      {result.configured && !result.error && (
        <PanelErrorBoundary label="Blacklist editor">
          <EmailBlacklistClient
            key={result.data
              .map((rule) => `${rule.id}:${rule.updatedAt}`)
              .join("|")}
            initialRules={result.data}
          />
        </PanelErrorBoundary>
      )}
    </>
  );
}

function EmailBlacklistFallback() {
  return (
    <>
      <KpiStripSkeleton count={3} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <FormCardSkeleton rows={1} />
        <FormCardSkeleton rows={3} />
      </div>
    </>
  );
}

export default async function EmailBlacklistPage() {
  await requireAntifraudPageAccess();
  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <Suspense fallback={<EmailBlacklistFallback />}>
        <EmailBlacklistContent />
      </Suspense>
    </div>
  );
}
