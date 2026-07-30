import { Suspense } from "react";
import { BadgeCheck, ClipboardCheck, ScanSearch, ShieldCheck } from "lucide-react";

import {
  FormCardSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import {
  listFiatPerkCandidates,
  listFiatPerkGrants,
  listFiatPerkRuns,
  type FiatPerkCandidate,
} from "@/lib/antifraud/fiat-perks-api";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { FiatPerksClient } from "./fiat-perks-client";

export const metadata = { title: "Fiat Perks · Antifraud" };

type SearchParams = {
  run?: string;
  verdict?: string;
  decision?: string;
  q?: string;
};

function verdictParam(value: string | undefined) {
  return value === "pass" || value === "review" || value === "fail"
    ? value
    : undefined;
}

function decisionParam(value: string | undefined) {
  return value === "pending" || value === "approved" || value === "declined"
    ? value
    : undefined;
}

async function Content({ params }: { params: SearchParams }) {
  const runs = await listFiatPerkRuns(20);
  const selectedRunId = params.run
    && runs.data.some((run) => run.id === params.run)
    ? params.run
    : runs.data[0]?.id;

  const [candidates, grants] = await Promise.all([
    selectedRunId
      ? listFiatPerkCandidates({
        runId: selectedRunId,
        verdict: verdictParam(params.verdict),
        decision: decisionParam(params.decision),
        search: params.q?.trim() || undefined,
      })
      : Promise.resolve({
        configured: true,
        error: false,
        data: [] as FiatPerkCandidate[],
      }),
    listFiatPerkGrants({ status: "granted" }),
  ]);

  const selectedRun = runs.data.find((run) => run.id === selectedRunId) ?? null;
  const unavailable = !runs.configured
    || runs.error
    || candidates.error
    || grants.error;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile
          label="Live perks"
          value={String(grants.data.length)}
          sub="accounts allowed on cards"
          icon={BadgeCheck}
          accent="emerald"
        />
        <KpiTile
          label="Waiting on you"
          value={String(selectedRun?.pendingCount ?? 0)}
          sub="screened, undecided"
          icon={ClipboardCheck}
          accent="amber"
        />
        <KpiTile
          label="Last sweep"
          value={String(selectedRun?.candidateCount ?? 0)}
          sub={selectedRun ? selectedRun.scopeLabel : "no run yet"}
          icon={ScanSearch}
          accent="cyan"
        />
        <KpiTile
          label="Cleared automatically"
          value={String(selectedRun?.passCount ?? 0)}
          sub="passed every check"
          icon={ShieldCheck}
          accent="blue"
        />
      </div>

      {unavailable && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {!runs.configured
            ? "The Antifraud monitor API is not configured, so screening is unavailable."
            : "Part of the screening data could not be loaded. No empty state is being assumed."}
        </div>
      )}

      <FiatPerksClient
        runs={runs.data}
        selectedRunId={selectedRunId ?? null}
        candidates={candidates.data}
        grants={grants.data}
        filters={{
          verdict: verdictParam(params.verdict) ?? null,
          decision: decisionParam(params.decision) ?? null,
          search: params.q ?? "",
        }}
        readOnly={!runs.configured}
      />
    </>
  );
}

function Fallback() {
  return (
    <>
      <KpiStripSkeleton count={4} />
      <FormCardSkeleton rows={3} />
      <FormCardSkeleton rows={6} />
    </>
  );
}

export default async function FiatPerksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAntifraudManagerPage();
  const params = await searchParams;

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense
        key={`${params.run ?? "latest"}-${params.verdict ?? "all"}-${
          params.decision ?? "all"
        }-${params.q ?? ""}`}
        fallback={<Fallback />}
      >
        <Content params={params} />
      </Suspense>
    </div>
  );
}
