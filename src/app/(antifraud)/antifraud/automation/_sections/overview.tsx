import {
  ArrowRight,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Gauge,
  RadioTower,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import {
  getAntifraudEventCatalog,
  getAntifraudPollerHealth,
  getAntifraudRuntimeConfig,
  getAntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import { AUTOMATION_FLOWS } from "../automation-catalog";
import {
  collectSystemIssues,
  type IssueSeverity,
  type SystemIssue,
} from "../_lib/system-issues";
import { readDiscordConfig } from "../_lib/read-discord-config";

/**
 * OVERVIEW TAB — "is the fraud engine fully wired, and what do I fix first?"
 *
 * Everything here is derived from the same reads the deeper tabs use, so the
 * numbers cannot drift from the pages an operator clicks through to.
 */
export async function AutomationOverview() {
  // Presence only — the values are never read into the render tree.
  const monitorApiUrlConfigured = Boolean(process.env.ANTIFRAUD_MONITOR_API_URL);
  const monitorApiTokenConfigured = Boolean(
    process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  );
  const ingestSecretConfigured = Boolean(process.env.ANTIFRAUD_INGEST_SECRET);

  const [scoring, events, discord, runtime, poller] = await Promise.all([
    getAntifraudScoringConfig(),
    getAntifraudEventCatalog(),
    readDiscordConfig(),
    getAntifraudRuntimeConfig(),
    getAntifraudPollerHealth(),
  ]);

  const issues = collectSystemIssues({
    monitorApiUrlConfigured,
    monitorApiTokenConfigured,
    ingestSecretConfigured,
    runtime: runtime.data,
    runtimeUnavailable: runtime.configured && (runtime.error || !runtime.data),
    poller: poller.data,
    pollerUnavailable: poller.configured && (poller.error || !poller.data),
    scoring: scoring.data,
    scoringUnavailable: scoring.configured && (scoring.error || !scoring.data),
    discord,
  });

  const criticalCount = issues.filter(
    (issue) => issue.severity === "critical",
  ).length;

  const rules = scoring.data?.behaviorRules ?? [];
  const activeRules = rules.filter((rule) => rule.enabled);
  const scoringReady = scoring.configured && !scoring.error && scoring.data !== null;
  const eventsReady = events.configured && !events.error;
  const liveEvents = events.data.filter((event) => event.status === "live");

  const enabledAlerts = discord?.events.filter((event) => event.enabled) ?? [];
  const routedKeys = new Set(
    discord?.routes.filter((route) => route.enabled).map((r) => r.eventKey) ?? [],
  );
  const routedAlerts = enabledAlerts.filter((event) => routedKeys.has(event.key));

  const engineState: { label: string; sub: string; accent: "emerald" | "amber" | "rose" } =
    !monitorApiUrlConfigured || !monitorApiTokenConfigured
      ? { label: "Offline", sub: "Monitor API not configured", accent: "rose" }
      : criticalCount > 0
        ? {
            label: "Degraded",
            sub: `${criticalCount} critical issue${criticalCount === 1 ? "" : "s"}`,
            accent: "rose",
          }
        : issues.length > 0
          ? {
              label: "Warnings",
              sub: `${issues.length} item${issues.length === 1 ? "" : "s"} to review`,
              accent: "amber",
            }
          : { label: "Healthy", sub: "Every check passed", accent: "emerald" };

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Engine status"
          value={engineState.label}
          sub={engineState.sub}
          icon={engineState.accent === "emerald" ? ShieldCheck : TriangleAlert}
          accent={engineState.accent}
        />
        <KpiTile
          label="Active detections"
          value={
            scoringReady
              ? String(AUTOMATION_FLOWS.length + activeRules.length)
              : String(AUTOMATION_FLOWS.length)
          }
          sub={
            scoringReady
              ? `${AUTOMATION_FLOWS.length} built-in · ${activeRules.length}/${rules.length} point flows`
              : `${AUTOMATION_FLOWS.length} built-in · flows unavailable`
          }
          icon={Workflow}
          accent="cyan"
        />
        <KpiTile
          label="Alert coverage"
          value={
            discord
              ? `${routedAlerts.length}/${enabledAlerts.length}`
              : "—"
          }
          sub={
            !discord
              ? "Routing unavailable"
              : routedAlerts.length === enabledAlerts.length
                ? "Every alert has a channel"
                : `${enabledAlerts.length - routedAlerts.length} without a channel`
          }
          icon={BellRing}
          accent={
            discord && routedAlerts.length === enabledAlerts.length
              ? "emerald"
              : "amber"
          }
        />
        <KpiTile
          label="Live event sources"
          value={eventsReady ? liveEvents.length.toLocaleString() : "—"}
          sub={
            eventsReady
              ? `${events.data.length - liveEvents.length} planned`
              : "Monitor unavailable"
          }
          icon={RadioTower}
          accent="blue"
        />
      </div>

      <IssueBoard issues={issues} />

      <section className="space-y-3">
        <SectionHeading icon={Gauge} title="How a decision is made" />
        <Pipeline />
      </section>

      {poller.data && (
        <section className="space-y-3">
          <SectionHeading
            icon={RadioTower}
            title="Ingestion loop"
            action={
              <Button
                size="sm"
                variant="outline"
                render={<HostLink href="/antifraud/settings?tab=health" />}
              >
                Full engine health
              </Button>
            }
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniStat
              label="Last successful tick"
              value={
                poller.data.lastSuccessfulTickAt
                  ? formatRelative(poller.data.lastSuccessfulTickAt)
                  : "Never"
              }
            />
            <MiniStat
              label="Signups processed"
              value={poller.data.signupsProcessed.toLocaleString()}
            />
            <MiniStat
              label="Activities processed"
              value={poller.data.activitiesProcessed.toLocaleString()}
            />
            <MiniStat
              label="Pending recovery"
              value={poller.data.signupFailuresPending.toLocaleString()}
              tone={poller.data.signupFailuresPending > 0 ? "warn" : "ok"}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "ok",
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-lg font-semibold tabular-nums",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function IssueBoard({ issues }: { issues: SystemIssue[] }) {
  if (issues.length === 0) {
    return (
      <section className="space-y-3">
        <SectionHeading icon={CheckCircle2} title="Needs attention" />
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-4">
          <CheckCircle2
            className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              No open issues
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Transport, providers, ingestion, point flows and alert routing all
              check out.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={TriangleAlert}
        title={
          <>
            Needs attention
            <span className="text-xs font-normal text-muted-foreground">
              {issues.length} open
            </span>
          </>
        }
      />
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="divide-y divide-border/60">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} />
          ))}
        </div>
      </div>
    </section>
  );
}

const SEVERITY_STYLES: Record<
  IssueSeverity,
  { icon: typeof CircleAlert; chip: string; label: string }
> = {
  critical: {
    icon: CircleAlert,
    chip: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    label: "Critical",
  },
  warning: {
    icon: TriangleAlert,
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    label: "Warning",
  },
};

function IssueRow({ issue }: { issue: SystemIssue }) {
  const style = SEVERITY_STYLES[issue.severity];
  const Icon = style.icon;
  return (
    <article className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="flex min-w-0 gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
            style.chip,
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{issue.title}</h3>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                style.chip,
              )}
            >
              {style.label}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {issue.detail}
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-fit md:justify-self-end"
        render={<HostLink href={issue.href} />}
      >
        {issue.actionLabel}
      </Button>
    </article>
  );
}

function Pipeline() {
  const steps = [
    {
      title: "1. Observe",
      text: "Signups, providers, payments, ledger activity, battles, devices, and staff actions.",
      icon: RadioTower,
    },
    {
      title: "2. Decide",
      text: "Risk weights, fixed safety policy, and ordered point flows turn evidence into a decision.",
      icon: Gauge,
    },
    {
      title: "3. Act",
      text: "Open review, contain withdrawals, ban, require KYC, allow or deny Fiat, or record evidence only.",
      icon: ShieldCheck,
    },
    {
      title: "4. Notify",
      text: "Durable event jobs route to configured Discord channels and the dashboard inbox.",
      icon: BellRing,
    },
  ];

  return (
    <div className="grid gap-2 lg:grid-cols-4">
      {steps.map((step, index) => {
        const Icon = step.icon;
        return (
          <div
            key={step.title}
            className="relative rounded-xl border border-border/60 bg-card px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                <Icon className="size-4" aria-hidden />
              </span>
              <p className="text-sm font-semibold">{step.title}</p>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {step.text}
            </p>
            {index < steps.length - 1 && (
              <ArrowRight
                className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-muted-foreground lg:block"
                aria-hidden
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
