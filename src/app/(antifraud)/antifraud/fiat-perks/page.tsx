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
  FIAT_PERK_PROVIDERS,
  listFiatPerkCandidates,
  listFiatPerkAccessBatches,
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
  access?: string;
  country?: string;
  riskMin?: string;
  riskMax?: string;
  mmStatus?: string;
  mmMin?: string;
  mmMax?: string;
  mmAction?: string;
  providers?: string;
  provider?: string;
  providerStatus?: string;
  providerCompleteness?: string;
  providerMin?: string;
  providerMax?: string;
  providerSignal?: string;
  ageMin?: string;
  ageMax?: string;
  reason?: string;
  cryptoMin?: string;
  fiatMin?: string;
  wagerMin?: string;
  rewardMax?: string;
};

function numberParam(value: string | undefined, max = 1_000_000_000) {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max
    ? parsed
    : undefined;
}

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
  const providerName = (FIAT_PERK_PROVIDERS as readonly string[])
    .includes(params.provider ?? "")
    ? params.provider as (typeof FIAT_PERK_PROVIDERS)[number]
    : undefined;
  const providerStatus = providerName
    && ["success", "skipped", "failed", "missing"]
      .includes(params.providerStatus ?? "")
    ? params.providerStatus as "success" | "skipped" | "failed" | "missing"
    : undefined;
  const providerHasEvidence = providerName && providerStatus !== "missing";

  const [candidates, grants, accessBatches] = await Promise.all([
    selectedRunId
      ? listFiatPerkCandidates({
        runId: selectedRunId,
        verdict: verdictParam(params.verdict),
        decision: decisionParam(params.decision),
        accessStatus: ["none", "unknown", "syncing", "enabled", "disabled", "error"]
          .includes(params.access ?? "")
          ? params.access as "none" | "unknown" | "syncing" | "enabled" | "disabled" | "error"
          : undefined,
        countryCode: /^[A-Za-z]{2}$/.test(params.country ?? "")
          ? params.country
          : undefined,
        minRiskScore: numberParam(params.riskMin, 100),
        maxRiskScore: numberParam(params.riskMax, 100),
        maxMindStatus: ["success", "failed", "skipped", "not_checked"]
          .includes(params.mmStatus ?? "")
          ? params.mmStatus as "success" | "failed" | "skipped" | "not_checked"
          : undefined,
        minMaxMindRisk: numberParam(params.mmMin, 100),
        maxMaxMindRisk: numberParam(params.mmMax, 100),
        maxMindDisposition: ["accept", "reject", "manual_review", "test"]
          .includes(params.mmAction ?? "")
          ? params.mmAction as "accept" | "reject" | "manual_review" | "test"
          : undefined,
        providerName,
        providerStatus,
        providerCompleteness: providerHasEvidence && ["complete", "partial", "unknown"]
          .includes(params.providerCompleteness ?? "")
          ? params.providerCompleteness as "complete" | "partial" | "unknown"
          : undefined,
        minProviderScore: providerHasEvidence
          ? numberParam(params.providerMin, 100)
          : undefined,
        maxProviderScore: providerHasEvidence
          ? numberParam(params.providerMax, 100)
          : undefined,
        providerSignal: providerHasEvidence
          ? params.providerSignal?.trim() || undefined
          : undefined,
        providerChecked: params.providers === "yes"
          ? true
          : params.providers === "no"
            ? false
            : undefined,
        minAccountAgeDays: numberParam(params.ageMin, 36500),
        maxAccountAgeDays: numberParam(params.ageMax, 36500),
        blockingReason: params.reason?.trim() || undefined,
        minCryptoDepositUsd: numberParam(params.cryptoMin),
        minFiatDepositUsd: numberParam(params.fiatMin),
        minWagerUsd: numberParam(params.wagerMin),
        maxRewardUsd: numberParam(params.rewardMax),
        search: params.q?.trim() || undefined,
      })
      : Promise.resolve({
        configured: true,
        error: false,
        data: [] as FiatPerkCandidate[],
      }),
    listFiatPerkGrants({ status: "granted" }),
    listFiatPerkAccessBatches(10),
  ]);

  const selectedRun = runs.data.find((run) => run.id === selectedRunId) ?? null;
  const unavailable = !runs.configured
    || runs.error
    || candidates.error
    || grants.error
    || accessBatches.error;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile
          label="Live perks"
          value={String(grants.data.filter((grant) => grant.accessStatus === "enabled").length)}
          sub="backend-confirmed access"
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
        accessBatches={accessBatches.data}
        filters={{
          verdict: verdictParam(params.verdict) ?? null,
          decision: decisionParam(params.decision) ?? null,
          search: params.q ?? "",
          access: params.access ?? "",
          country: params.country ?? "",
          riskMin: params.riskMin ?? "",
          riskMax: params.riskMax ?? "",
          mmStatus: params.mmStatus ?? "",
          mmMin: params.mmMin ?? "",
          mmMax: params.mmMax ?? "",
          mmAction: params.mmAction ?? "",
          providers: params.providers ?? "",
          provider: params.provider ?? "",
          providerStatus: params.providerStatus ?? "",
          providerCompleteness: params.providerCompleteness ?? "",
          providerMin: params.providerMin ?? "",
          providerMax: params.providerMax ?? "",
          providerSignal: params.providerSignal ?? "",
          ageMin: params.ageMin ?? "",
          ageMax: params.ageMax ?? "",
          reason: params.reason ?? "",
          cryptoMin: params.cryptoMin ?? "",
          fiatMin: params.fiatMin ?? "",
          wagerMin: params.wagerMin ?? "",
          rewardMax: params.rewardMax ?? "",
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
        }-${JSON.stringify(params)}`}
        fallback={<Fallback />}
      >
        <Content params={params} />
      </Suspense>
    </div>
  );
}
