import "server-only";

import { Suspense } from "react";
import {
  Users,
  ShieldAlert,
  ShieldCheck,
  Network,
  Wallet,
  Clock,
  Fingerprint,
  Coins,
  Globe,
  Info,
  TriangleAlert,
} from "lucide-react";

import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { HubNotice } from "../../../_components/hub-notice";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { cn } from "@/lib/utils";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

import {
  getAltAccountsData,
  type AltAccountsData,
  type AltCluster,
  type AltSignalKind,
  type AltSignalSummary,
} from "../_queries/alt-accounts-data";

/**
 * Creator Hub — `creators/[id]` **Alt Accounts** tab.
 *
 * Collusion / self-boost detector: clusters the creator's affiliate-code
 * cohort by shared low-level signals (IP, subnet, device, deposit wallet,
 * deposit timing, identical deposit, and the platform's own alt flag) and
 * surfaces suspected alt clusters worst-first with a collusion flag.
 *
 * LAZY: this component is only mounted when the Alt Accounts tab is opened, and
 * the heavy scan runs in its own Suspense boundary so opening the tab paints
 * the heading immediately while the cluster scan streams in. The scan is cached
 * (prod-pinned) + timeout-bounded; a slow scan degrades to a notice rather than
 * hanging.
 *
 * PII: IP addresses and wallet addresses are correlated server-side and only
 * ever rendered MASKED (the query module redacts them before they reach this
 * component). Nothing here re-derives or logs a raw IP.
 *
 * House-POV note: this is a RISK surface, not a money surface, so it uses
 * neutral risk semantics — amber for "review", rose/destructive for a
 * confirmed collusion flag, emerald only for the "all clear" state. The dollar
 * figures shown (cohort deposits / wager) follow house-POV (user money in =
 * emerald) but are contextual, not the focus.
 *
 * Props: `userId` (the creator's user id) — the component resolves the
 * creator's code + cohort itself, so it's self-contained and wiring-agnostic.
 */
export function AltAccountsTab({ userId }: { userId: string }) {
  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <SectionHeading
        icon={ShieldAlert}
        title="Alt Accounts — collusion & self-boost detection"
      />
      <Suspense fallback={<AltAccountsSkeleton />}>
        <AltAccountsContent userId={userId} />
      </Suspense>
    </FadeIn>
  );
}

async function AltAccountsContent({ userId }: { userId: string }) {
  // The whole clustering scan is multi-query but each sub-query is a single
  // grouped round-trip; 20s budget mirrors the creator-detail heavy reads.
  const { data, kind } = await safeQueryOrNull(
    () => getAltAccountsData(userId),
    "creator-hub.alt-accounts",
    20_000,
  );

  if (!data) {
    // Truthful band copy — a hard failure must not masquerade as "slow".
    const timedOut = kind === "timeout";
    return (
      <HubNotice
        tone="amber"
        icon={Info}
        title={
          timedOut
            ? "Alt-account scan is taking too long to load"
            : "Alt-account scan failed to load"
        }
      >
        {timedOut
          ? "The cohort correlation scan timed out. Refresh to retry — the rest of the page is unaffected."
          : "The cohort correlation scan failed — its data is unavailable right now. Refresh to retry; the rest of the page is unaffected."}
      </HubNotice>
    );
  }

  if (data.codes.length === 0) {
    return (
      <HubNotice tone="muted" icon={Info} title="No affiliate code on this creator">
        This creator has no affiliate code yet, so there&apos;s no
        referred-user cohort to analyse for alts.
      </HubNotice>
    );
  }

  return (
    <div className="space-y-5">
      <AltKpiStrip data={data} />

      {data.gaps.length > 0 && <DataGapNotice data={data} />}

      {data.clusters.length === 0 ? (
        <AllClearBanner cohortSize={data.cohortSize} partial={data.partial} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">
              Suspected alt clusters
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {data.clusters.length} found · worst first
              </span>
            </h3>
          </div>
          <div className="space-y-3">
            {data.clusters.map((cluster) => (
              <ClusterCard key={cluster.id} cluster={cluster} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────────

function AltKpiStrip({ data }: { data: AltAccountsData }) {
  const collusionCount = data.clusters.filter((c) => c.collusion).length;
  const reviewCount = data.clusters.length - collusionCount;
  // Distinct users implicated across all clusters.
  const implicated = new Set<string>();
  for (const c of data.clusters) for (const m of c.members) implicated.add(m.userId);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label="Cohort size"
        value={String(data.cohortSize)}
        sub="Referred users analysed"
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Collusion flags"
        value={String(collusionCount)}
        sub={collusionCount > 0 ? "Probable same-operator" : "None detected"}
        icon={ShieldAlert}
        accent={collusionCount > 0 ? "rose" : "emerald"}
      />
      <KpiTile
        label="To review"
        value={String(reviewCount)}
        sub="Single soft-signal links"
        icon={TriangleAlert}
        accent={reviewCount > 0 ? "amber" : "emerald"}
      />
      <KpiTile
        label="Users implicated"
        value={String(implicated.size)}
        sub="Across all clusters"
        icon={Network}
        accent={implicated.size > 0 ? "amber" : "emerald"}
      />
      <KpiTile
        label="Platform alt-flagged"
        value={String(data.platformAltFlaggedCount)}
        sub="Game's own heuristic"
        icon={Fingerprint}
        accent={data.platformAltFlaggedCount > 0 ? "rose" : "emerald"}
      />
    </div>
  );
}

// ─── Cluster card ───────────────────────────────────────────────────────────

function ClusterCard({ cluster }: { cluster: AltCluster }) {
  const Icon = cluster.collusion ? ShieldAlert : TriangleAlert;
  const hardCount = cluster.signals.filter((s) => s.strength === "hard").length;

  return (
    <Card
      size="sm"
      className={cn(
        "gap-0 overflow-hidden p-0 ring-1",
        cluster.collusion
          ? "ring-rose-500/30 bg-rose-500/[0.03]"
          : "ring-amber-500/25 bg-amber-500/[0.02]",
      )}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl border",
              cluster.collusion
                ? "border-rose-500/30 bg-rose-500/10 text-rose-500"
                : "border-amber-500/30 bg-amber-500/10 text-amber-500",
            )}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "text-base font-semibold leading-none",
                  cluster.collusion
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-amber-600 dark:text-amber-400",
                )}
              >
                {cluster.collusion ? "Likely collusion" : "Review"}
              </span>
              <span className="rounded-md border border-border/60 bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {cluster.members.length} accounts
              </span>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Risk score{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {cluster.score}
              </span>
              /100 · {cluster.signals.length} signal
              {cluster.signals.length === 1 ? "" : "s"}
              {hardCount > 0 && ` (${hardCount} hard)`}
            </p>
          </div>
        </div>

        {/* Cluster money context (house-POV: user money in = emerald). */}
        <div className="flex items-center gap-6 text-right">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Deposits
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums leading-none text-emerald-600 dark:text-emerald-400">
              {cluster.clusterDepositsUsd > 0
                ? formatCurrency(cluster.clusterDepositsUsd)
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Wager (code)
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums leading-none text-emerald-600 dark:text-emerald-400">
              {cluster.clusterWagerUsd > 0
                ? formatCurrency(cluster.clusterWagerUsd)
                : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Evidence — one readable row per signal, nothing truncated. */}
      <div className="px-5 py-4">
        <div className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Evidence
        </div>
        <div className="space-y-2">
          {cluster.signals.map((s, i) => (
            <SignalRow key={`${s.kind}-${i}`} signal={s} />
          ))}
        </div>
      </div>

      {/* Members */}
      <div className="border-t border-border/60">
        <div className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Accounts in this cluster
        </div>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 border-b border-border/60 px-5 pb-2 text-xs font-medium text-muted-foreground sm:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <span>Account</span>
          <span className="hidden sm:block">Joined</span>
          <span className="text-right">Deposits</span>
          <span className="text-right">Wager</span>
        </div>
        <div className="divide-y divide-border/40">
          {cluster.members.map((m) => (
            <div
              key={m.userId}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-4 px-5 py-3 text-sm sm:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {m.username ?? (
                    <span className="text-muted-foreground italic">
                      (no username)
                    </span>
                  )}
                </div>
                {m.maskedEmail && (
                  <div className="truncate text-xs text-muted-foreground">
                    {m.maskedEmail}
                  </div>
                )}
                {m.createdAt && (
                  <div className="text-xs text-muted-foreground sm:hidden">
                    joined {formatDateTime(m.createdAt)}
                  </div>
                )}
              </div>
              <div className="hidden text-sm tabular-nums text-muted-foreground sm:block">
                {m.createdAt ? formatDateTime(m.createdAt) : "—"}
              </div>
              <div className="text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {m.depositsUsd > 0 ? formatCurrency(m.depositsUsd) : "—"}
              </div>
              <div className="text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                {m.wagerUsd > 0 ? formatCurrency(m.wagerUsd) : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

const SIGNAL_ICON: Record<AltSignalKind, React.ElementType> = {
  shared_ip: Globe,
  shared_subnet: Network,
  shared_device: Fingerprint,
  reused_wallet: Wallet,
  synchronized_deposit: Clock,
  identical_deposit: Coins,
  platform_alt_flag: ShieldAlert,
};

/**
 * One evidence row per signal. Replaces the old micro-chip: the detail
 * (masked wallet / IP / timestamp) is the thing an analyst actually reads, so
 * it gets a full-width monospace line that wraps instead of a 160px truncation
 * hidden behind a tooltip.
 */
function SignalRow({ signal }: { signal: AltSignalSummary }) {
  const Icon = SIGNAL_ICON[signal.kind];
  const hard = signal.strength === "hard";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border p-3 sm:flex-nowrap sm:items-center",
        hard
          ? "border-rose-500/25 bg-rose-500/[0.06]"
          : "border-amber-500/20 bg-amber-500/[0.05]",
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border",
          hard
            ? "border-rose-500/30 bg-rose-500/10 text-rose-500"
            : "border-amber-500/30 bg-amber-500/10 text-amber-500",
        )}
      >
        <Icon className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "text-sm font-semibold",
              hard
                ? "text-rose-600 dark:text-rose-400"
                : "text-amber-600 dark:text-amber-400",
            )}
          >
            {signal.label}
          </span>
          <span
            className={cn(
              "rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
              hard
                ? "border-rose-500/30 text-rose-600 dark:text-rose-400"
                : "border-amber-500/30 text-amber-600 dark:text-amber-400",
            )}
          >
            {hard ? "Hard evidence" : "Corroborating"}
          </span>
        </div>
        <div className="mt-1 break-all font-mono text-sm text-foreground/90">
          {signal.detail}
        </div>
      </div>

      <div className="shrink-0 text-left sm:text-right">
        <div className="text-base font-semibold tabular-nums leading-none">
          {signal.userCount}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          account{signal.userCount === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

// ─── Notices / states ─────────────────────────────────────────────────────

function AllClearBanner({
  cohortSize,
  partial,
}: {
  cohortSize: number;
  partial: boolean;
}) {
  // HubNotice has no emerald tone (it's a degraded/info primitive), but the
  // alt tab's house convention reserves emerald for the true all-clear —
  // overlay it via className on the shared chassis rather than keeping a
  // bespoke banner.
  return (
    <HubNotice
      tone={partial ? "amber" : "muted"}
      icon={partial ? Info : ShieldCheck}
      className={
        partial
          ? undefined
          : "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
      }
      title={
        partial
          ? "No alt clusters in the signals we could read"
          : "No suspected alt clusters"
      }
    >
      {partial
        ? `Across the ${cohortSize} referred user${cohortSize === 1 ? "" : "s"} analysed, none shared the signals that loaded successfully. Some signals degraded (see the notice above), so this is a lower bound — re-run after a refresh.`
        : `None of the ${cohortSize} referred user${cohortSize === 1 ? "" : "s"} under this creator's code share an IP, subnet, device, deposit wallet, deposit-timing, or identical-deposit signal. No self-boost pattern detected.`}
    </HubNotice>
  );
}

function DataGapNotice({ data }: { data: AltAccountsData }) {
  return (
    <HubNotice
      tone="amber"
      icon={Info}
      title="Some signals are unavailable on this database — results are a lower bound"
    >
      <ul className="space-y-1">
        {data.gaps.map((g) => (
          <li key={g.kind} className="flex gap-1.5">
            <span className="mt-1 size-1 shrink-0 rounded-full bg-amber-500/60" />
            <span>
              <span className="font-medium text-foreground/80">
                {g.label}:
              </span>{" "}
              {g.reason}
            </span>
          </li>
        ))}
      </ul>
    </HubNotice>
  );
}

// ─── Skeleton ──────────────────────────────────────────────────────────────

export function AltAccountsSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} size="sm" className="space-y-2 p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-24" />
          </Card>
        ))}
      </div>
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Card key={i} size="sm" className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-8 w-32" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-6 w-28 rounded-lg" />
              <Skeleton className="h-6 w-28 rounded-lg" />
            </div>
            <Skeleton className="h-px w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}
