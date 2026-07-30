import { Suspense } from "react";
import { Fingerprint, Network, ShieldAlert } from "lucide-react";

import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  listIdentifierBlocklist,
  type IdentifierBlocklistKind,
} from "@/lib/antifraud/identifier-blocklists-api";
import { IdentifierBlocklistClient } from "./identifier-blocklist-client";

async function Content({ kind }: { kind: IdentifierBlocklistKind }) {
  const result = await listIdentifierBlocklist(kind);
  const active = result.data.filter((rule) => rule.enabled);
  const affected = result.data.reduce(
    (total, rule) => total + rule.affectedUsers,
    0,
  );
  const matches30d = result.data.reduce(
    (total, rule) => total + rule.matches30d,
    0,
  );
  const Icon = kind === "ip" ? Network : Fingerprint;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Active rules" value={String(active.length)} icon={Icon} accent="rose" />
        <KpiTile label="Affected users" value={String(affected)} icon={ShieldAlert} accent="orange" />
        <KpiTile label="Matches · 30d" value={String(matches30d)} icon={Icon} accent="cyan" />
      </div>
      {(!result.configured || result.error) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!result.configured
            ? "The Antifraud monitor API is not configured, so blocklist changes are unavailable."
            : "The live blocklist could not be loaded. No empty state is being assumed."}
        </div>
      )}
      {result.configured && !result.error && (
        <IdentifierBlocklistClient
          key={result.data.map((rule) => `${rule.id}:${rule.updatedAt}`).join("|")}
          kind={kind}
          initialRules={result.data}
        />
      )}
    </>
  );
}

export function IdentifierBlocklistFallback() {
  return (
    <>
      <KpiStripSkeleton count={3} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
        <FormCardSkeleton rows={4} />
        <FormCardSkeleton rows={4} />
      </div>
    </>
  );
}

export function IdentifierBlocklistPage({
  kind,
}: {
  kind: IdentifierBlocklistKind;
}) {
  return (
    <div className="space-y-6">
      <PageHero><PageHeroIdentity /></PageHero>
      <Suspense fallback={<IdentifierBlocklistFallback />}>
        <Content kind={kind} />
      </Suspense>
    </div>
  );
}
