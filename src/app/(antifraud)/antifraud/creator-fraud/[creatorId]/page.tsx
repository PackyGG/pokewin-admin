import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  Activity,
  BadgeDollarSign,
  Gauge,
  ListChecks,
  Network,
  ShieldAlert,
  UserRound,
  Users,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getCreatorFraud,
  type CreatorFraudAssessment,
  type CreatorWindow,
} from "@/lib/antifraud/network-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { RiskScoreBar } from "../../_components/risk-score-bar";
import { ScanPoller } from "../../networks/scan-poller";
import { CreatorRescanButton } from "../creator-rescan-button";

export const metadata = { title: "Affiliate Cohort Assessment · Antifraud" };

const WINDOW_LABELS: Record<CreatorWindow, string> = {
  "7d": "7-day window",
  "30d": "30-day window",
  "90d": "90-day window",
  lifetime: "Lifetime window",
};

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
          title="Affiliate cohort assessment"
          subtitle="Only referred-account networks and activity; creator account behavior is excluded"
          backHref={`/antifraud/creator-fraud?window=${window}`}
          action={
            <>
              <CreatorRescanButton creatorId={creatorId} window={window} />
              <Button
                size="sm"
                variant="outline"
                render={<HostLink href={`/users/${creatorId}`} />}
              >
                <UserRound className="size-4" />
                User profile
              </Button>
            </>
          }
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
  const creator = assessment.creator;
  const creatorName =
    creator?.display_username ?? creator?.username ?? creatorId;
  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-11">
              {creator?.image && <AvatarImage src={creator.image} alt="" />}
              <AvatarFallback>{creatorName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">{creatorName}</h1>
              <p className="truncate text-xs text-muted-foreground">
                {creator?.email ?? creatorId}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {assessment.codes.map((code) => (
              <Badge key={code} variant="outline" className="font-mono">
                {code}
              </Badge>
            ))}
            <SeverityBadge score={assessment.score} severity={assessment.severity} />
            {assessment.partial && (
              <Badge
                variant="outline"
                className="border-amber-500/30 text-amber-600 dark:text-amber-400"
              >
                Partial data
              </Badge>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {WINDOW_LABELS[window]} · assessed {formatRelative(assessment.assessed_at)}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          icon={Gauge}
          accent={riskAccent(assessment.score)}
          label="Cohort risk"
          value={`${assessment.score}/100`}
          sub={`${assessment.severity} · raw ${assessment.raw_score} points`}
        />
        <KpiTile
          icon={Users}
          accent="cyan"
          label="Referred accounts"
          value={metrics.cohortSize.toLocaleString()}
          sub={`${metrics.connectedAccounts.toLocaleString()} mapped in networks`}
        />
        <KpiTile
          icon={BadgeDollarSign}
          accent="emerald"
          label="Cohort deposits"
          value={formatCurrency(metrics.depositsUsd)}
          sub={`${formatCurrency(metrics.withdrawalsUsd)} withdrawn`}
        />
        <KpiTile
          icon={Activity}
          accent="emerald"
          label="Cohort wager"
          value={formatCurrency(metrics.wagerUsd)}
          sub="gross wagered in window"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <div className="min-w-0 space-y-6">
          <TriggeredChecks assessment={assessment} metrics={metrics} />
        </div>
        <aside className="min-w-0 space-y-5">
          <RiskBreakdown assessment={assessment} />
          <NetworkMaps metrics={metrics} />
        </aside>
      </div>
    </div>
  );
}

function TriggeredChecks({
  assessment,
  metrics,
}: {
  assessment: CreatorFraudAssessment;
  metrics: CreatorMetrics;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ListChecks}
        title={
          <>
            Triggered checks
            <span className="text-xs font-normal text-muted-foreground">
              affiliate-cohort signals in this window
            </span>
          </>
        }
      />
      {assessment.signals.length > 0 ? (
        <div className="space-y-2">
          {assessment.signals.map((signal) => (
            <div
              key={signal.key}
              className="rounded-xl border border-rose-500/25 bg-card p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{signal.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {signal.detail}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 border-rose-500/30 text-rose-600 dark:text-rose-400"
                >
                  +{signal.points} pts
                </Badge>
              </div>
              <SignalEvidence signalKey={signal.key} metrics={metrics} />
            </div>
          ))}
        </div>
      ) : (
        <Empty text="No affiliate-cohort checks triggered in this window." />
      )}
    </section>
  );
}

function RiskBreakdown({ assessment }: { assessment: CreatorFraudAssessment }) {
  const categories = [
    { label: "Affiliate networks", value: assessment.breakdown.network },
    { label: "Signup patterns", value: assessment.breakdown.affiliate },
    { label: "Affiliate activity", value: assessment.breakdown.behavior },
  ];
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
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
      <div className="mt-3">
        <RiskScoreBar score={assessment.score} />
      </div>
      <div className="mt-4 space-y-3">
        {categories.map((category) => (
          <div key={category.label}>
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-muted-foreground">{category.label}</span>
              <span className="font-semibold tabular-nums">{category.value}</span>
            </div>
            <RiskScoreBar score={category.value} />
          </div>
        ))}
      </div>
    </div>
  );
}

function NetworkMaps({ metrics }: { metrics: CreatorMetrics }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Network className="size-4 text-cyan-500" />
        <p className="text-sm font-semibold">Network maps</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Open complete account components detected among referred accounts.
      </p>
      {metrics.networkCount === 0 && metrics.networkRoots.length > 0 && (
        <p className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          Shared-IP groups were detected. Their graph scans are queued and may
          still be building.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {metrics.networkRoots.length > 0 ? (
          metrics.networkRoots.slice(0, 6).map((root) => (
            <Button
              key={root}
              size="sm"
              variant="outline"
              render={
                <HostLink href={`/antifraud/networks?user=${encodeURIComponent(root)}`} />
              }
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
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
    return (
      <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
        {emptyText}
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-1.5">
      {groups.map((group, index) => (
        <div
          key={`${group.rootUserId}-${index}`}
          className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px]"
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
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-sm font-semibold tabular-nums",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400",
          tone === "negative" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function SeverityBadge({ score, severity }: { score: number; severity: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "capitalize",
        score >= 60 && "border-rose-500/30 text-rose-600 dark:text-rose-400",
        score >= 30 && score < 60 &&
          "border-amber-500/30 text-amber-600 dark:text-amber-400",
        score < 30 &&
          "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {severity} · {score}/100
    </Badge>
  );
}

function riskAccent(score: number): "emerald" | "amber" | "rose" {
  if (score >= 60) return "rose";
  if (score >= 30) return "amber";
  return "emerald";
}

function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center text-sm text-muted-foreground">
      {text}
      {children}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-24 rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
