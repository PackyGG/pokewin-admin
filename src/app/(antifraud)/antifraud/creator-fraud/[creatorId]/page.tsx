import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  Activity,
  BadgeDollarSign,
  Network,
  ShieldAlert,
  Users,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getCreatorFraud,
  type CreatorFraudAssessment,
  type CreatorWindow,
} from "@/lib/antifraud/network-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { formatCurrency } from "@/lib/utils/format";
import { RiskScoreBar } from "../../_components/risk-score-bar";
import { ScanPoller } from "../../networks/scan-poller";
import { CreatorRescanButton } from "../creator-rescan-button";

export const metadata = { title: "Creator Assessment · Antifraud" };

export default async function CreatorFraudDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ creatorId: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  await requireAntifraudPageAccess();
  const creatorId = (await params).creatorId;
  if (!creatorId || creatorId.length > 100) notFound();
  const rawWindow = (await searchParams).window;
  const window: CreatorWindow =
    rawWindow === "7d" ||
    rawWindow === "90d" ||
    rawWindow === "lifetime"
      ? rawWindow
      : "30d";
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Creator assessment"
          subtitle="Network, affiliate, and gameplay/money evidence"
        />
      </PageHero>
      <Suspense key={`${creatorId}-${window}`} fallback={<DetailSkeleton />}>
        <CreatorDetail creatorId={creatorId} window={window} />
      </Suspense>
    </div>
  );
}

async function CreatorDetail({
  creatorId,
  window,
}: {
  creatorId: string;
  window: CreatorWindow;
}) {
  const result = await getCreatorFraud(creatorId, window);
  if (!result.configured) return <Empty text="The monitor service is not configured." />;
  if (result.error) return <Empty text="The creator assessment could not be loaded." />;
  if (result.queued || !result.data) {
    return (
      <Empty text="The creator assessment is being calculated. This page refreshes every 30 seconds.">
        <ScanPoller />
      </Empty>
    );
  }
  const assessment = result.data;
  const metrics = readMetrics(assessment);
  const creatorName =
    assessment.creator?.display_username ??
    assessment.creator?.username ??
    creatorId;
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{creatorName}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {assessment.codes.map((code) => (
              <Badge key={code} variant="outline" className="font-mono">
                {code}
              </Badge>
            ))}
          </div>
        </div>
        <CreatorRescanButton creatorId={creatorId} window={window} />
      </div>

      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/70 bg-card lg:grid-cols-4">
        <Metric icon={Users} label="Cohort" value={String(metrics.cohortSize)} />
        <Metric icon={Network} label="Mapped" value={String(metrics.connectedAccounts)} />
        <Metric icon={BadgeDollarSign} label="Deposits" value={formatCurrency(metrics.depositsUsd)} tone="positive" />
        <Metric icon={Activity} label="Wager" value={formatCurrency(metrics.wagerUsd)} tone="positive" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <section className="rounded-xl border border-border/70 bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span>
              <span className="block text-sm font-semibold capitalize">
                {assessment.severity} risk
              </span>
              <span className="block text-xs text-muted-foreground">
                Raw {assessment.raw_score} points · displayed 0–100
              </span>
            </span>
            <span className="text-xl font-bold tabular-nums">{assessment.score}</span>
          </div>
          <RiskScoreBar score={assessment.score} />
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Breakdown label="Network" value={assessment.breakdown.network} />
            <Breakdown label="Affiliate" value={assessment.breakdown.affiliate} />
            <Breakdown label="Behavior" value={assessment.breakdown.behavior} />
          </div>
        </section>

        <section className="rounded-xl border border-border/70 bg-card p-4">
          <p className="text-sm font-semibold">Network maps</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Open complete account components detected from creator evidence.
          </p>
          {metrics.networkCount === 0 && metrics.networkRoots.length > 0 && (
            <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              Shared-IP groups were detected. Their graph scans are queued and
              may still be building.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {metrics.networkRoots.length > 0 ? (
              metrics.networkRoots.slice(0, 6).map((root) => (
                <Button
                  key={root}
                  size="sm"
                  variant="outline"
                  render={<HostLink href={`/antifraud/networks?user=${encodeURIComponent(root)}`} />}
                >
                  <Network className="size-3.5" />
                  {evidenceLabel(metrics, root)}
                </Button>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">
                No shared IP/device component has been recorded yet.
              </span>
            )}
          </div>
        </section>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Triggered checks</h2>
        {assessment.signals.length > 0 ? (
          <div className="space-y-2">
            {assessment.signals.map((signal) => (
              <div key={signal.key} className="grid gap-2 rounded-lg border border-border/70 bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <span>
                  <span className="block text-sm font-medium">{signal.title}</span>
                  <span className="block text-xs text-muted-foreground">{signal.detail}</span>
                  <SignalEvidence signalKey={signal.key} metrics={metrics} />
                </span>
                <Badge variant="outline" className="border-rose-500/25 text-rose-600 dark:text-rose-400">
                  +{signal.points} pts
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="No creator-fraud checks triggered in this window." />
        )}
      </section>
    </div>
  );
}

function readMetrics(assessment: CreatorFraudAssessment) {
  const number = (key: string) => {
    const parsed = Number(assessment.metrics[key] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const groups = (key: string): CreatorEvidenceGroup[] => {
    const value = assessment.metrics[key];
    if (!Array.isArray(value)) return [];
    return value.flatMap((group) => {
      if (!group || typeof group !== "object") return [];
      const record = group as Record<string, unknown>;
      if (
        typeof record.rootUserId !== "string" ||
        !Array.isArray(record.members)
      ) {
        return [];
      }
      const members = record.members.flatMap((member) => {
        if (!member || typeof member !== "object") return [];
        const memberRecord = member as Record<string, unknown>;
        if (typeof memberRecord.userId !== "string") return [];
        return [{
          userId: memberRecord.userId,
          username:
            typeof memberRecord.username === "string"
              ? memberRecord.username
              : null,
        }];
      });
      if (members.length < 2) return [];
      return [{
        accountCount: numberFromUnknown(record.accountCount, members.length),
        rootUserId: record.rootUserId,
        members,
      }];
    });
  };
  const roots = assessment.metrics.networkRoots;
  return {
    cohortSize: number("cohortSize"),
    connectedAccounts: number("connectedAccounts"),
    externalAccounts: number("externalAccounts"),
    networkCount: number("networkCount"),
    detectedIpAccounts: number("detectedIpAccounts"),
    depositsUsd: number("depositsUsd"),
    wagerUsd: number("wagerUsd"),
    withdrawalsUsd: number("withdrawalsUsd"),
    expectedGgrUsd: number("expectedGgrUsd"),
    actualValueUsd: number("actualValueUsd"),
    ggrGapUsd: number("ggrGapUsd"),
    ipGroups: groups("ipGroups"),
    walletGroups: groups("walletGroups"),
    networkRoots: Array.isArray(roots)
      ? roots.filter((value): value is string => typeof value === "string")
      : [],
  };
}

type CreatorEvidenceGroup = {
  accountCount: number;
  rootUserId: string;
  members: Array<{ userId: string; username: string | null }>;
};

type CreatorMetrics = ReturnType<typeof readMetrics>;

function numberFromUnknown(value: unknown, fallback = 0): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function evidenceLabel(metrics: CreatorMetrics, rootUserId: string): string {
  for (const group of metrics.ipGroups) {
    const member = group.members.find((item) => item.userId === rootUserId);
    if (member) return member.username ?? rootUserId.slice(0, 10);
  }
  return rootUserId.slice(0, 10);
}

function SignalEvidence({
  signalKey,
  metrics,
}: {
  signalKey: string;
  metrics: CreatorMetrics;
}) {
  if (signalKey === "creator_ip_chain") {
    return (
      <EvidenceGroups
        groups={metrics.ipGroups}
        networkLinks
        emptyText="The next assessment will attach the involved account names."
      />
    );
  }
  if (signalKey === "creator_wallet_reuse") {
    return (
      <EvidenceGroups
        groups={metrics.walletGroups}
        emptyText="The next assessment will attach the involved account names."
      />
    );
  }
  if (signalKey === "creator_ggr_shortfall") {
    return (
      <div className="mt-2 grid gap-1.5 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
        <EvidenceMetric label="Expected GGR" value={formatCurrency(metrics.expectedGgrUsd)} />
        <EvidenceMetric label="Deposits" value={formatCurrency(metrics.depositsUsd)} tone="positive" />
        <EvidenceMetric label="Withdrawals" value={formatCurrency(metrics.withdrawalsUsd)} tone="negative" />
        <EvidenceMetric label="Actual value" value={formatCurrency(metrics.actualValueUsd)} tone={metrics.actualValueUsd < 0 ? "negative" : "positive"} />
      </div>
    );
  }
  return null;
}

function EvidenceGroups({
  groups,
  networkLinks = false,
  emptyText,
}: {
  groups: CreatorEvidenceGroup[];
  networkLinks?: boolean;
  emptyText: string;
}) {
  if (groups.length === 0) {
    return <span className="mt-2 block text-[11px] text-amber-600 dark:text-amber-400">{emptyText}</span>;
  }
  return (
    <div className="mt-2 space-y-1.5">
      {groups.map((group, index) => (
        <div
          key={`${group.rootUserId}-${index}`}
          className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[11px]"
        >
          <span className="font-medium">Group {index + 1}:</span>
          {group.members.map((member) => (
            <HostLink
              key={member.userId}
              href={`/users/${member.userId}`}
              className="text-cyan-600 hover:underline dark:text-cyan-400"
            >
              {member.username ?? member.userId.slice(0, 10)}
            </HostLink>
          ))}
          {networkLinks && (
            <HostLink
              href={`/antifraud/networks?user=${encodeURIComponent(group.rootUserId)}`}
              className="ml-auto inline-flex items-center gap-1 font-medium text-cyan-600 hover:underline dark:text-cyan-400"
            >
              <Network className="size-3" />
              Open network
            </HostLink>
          )}
        </div>
      ))}
    </div>
  );
}

function EvidenceMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  return (
    <span className="rounded-md bg-muted/40 px-2 py-1.5">
      <span className="block text-muted-foreground">{label}</span>
      <span className={
        tone === "positive"
          ? "font-semibold text-emerald-600 dark:text-emerald-400"
          : tone === "negative"
            ? "font-semibold text-rose-600 dark:text-rose-400"
            : "font-semibold"
      }>
        {value}
      </span>
    </span>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  tone?: "positive";
}) {
  return (
    <div className="flex items-center gap-2.5 border-border/70 p-3 [&:not(:last-child)]:border-r">
      <Icon className="size-4 text-cyan-500" />
      <span>
        <span className="block text-[11px] text-muted-foreground">{label}</span>
        <span className={tone === "positive" ? "block font-semibold text-emerald-600 dark:text-emerald-400" : "block font-semibold"}>
          {value}
        </span>
      </span>
    </div>
  );
}

function Breakdown({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md bg-muted/40 p-2 text-center">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="block text-sm font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
      {text}
      {children}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-20 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
