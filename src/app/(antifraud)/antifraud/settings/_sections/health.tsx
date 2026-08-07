import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  RadioTower,
  TriangleAlert,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import {
  getAntifraudNotificationRoutes,
  getAntifraudPollerHealth,
  getAntifraudRuntimeConfig,
  type AntifraudPollerHealth,
} from "@/lib/antifraud/monitor-api";
import { getSignupIngestionFailures } from "@/lib/antifraud/signup-failures-api";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import { SignupFailureManager } from "../_components/signup-failure-manager";

export async function EngineHealthSection() {
  const [poller, runtime, routes, signupFailures] = await Promise.all([
    getAntifraudPollerHealth(),
    getAntifraudRuntimeConfig(),
    getAntifraudNotificationRoutes(),
    getSignupIngestionFailures(),
  ]);

  if (!poller.configured) {
    return (
      <HealthNotice
        tone="error"
        title="Monitor connection is not configured"
        detail="The dashboard cannot verify ingestion, so delayed assessments could go unnoticed."
        href="/antifraud/guide/troubleshooting"
        action="Open troubleshooting"
      />
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading icon={Activity} title="Ingestion" />
        {poller.error || !poller.data ? (
          <HealthNotice
            tone="error"
            title="Ingestion status is unavailable"
            detail="The monitor did not answer, so the dashboard cannot confirm that new activity is being assessed."
            href="/antifraud/guide/troubleshooting"
            action="Open troubleshooting"
          />
        ) : (
          <PollerPanel health={poller.data} />
        )}
      </section>

      {signupFailures.configured && !signupFailures.error ? (
        <SignupFailureManager failures={signupFailures.data} />
      ) : poller.data && poller.data.signupFailuresPending > 0 ? (
        <HealthNotice
          tone="error"
          title="Signup recovery queue is unavailable"
          detail={`${poller.data.signupFailuresPending.toLocaleString()} signup${poller.data.signupFailuresPending === 1 ? " has" : "s have"} no completed assessment, but the recovery controls could not be loaded.`}
          href="/antifraud/guide/troubleshooting"
          action="Open troubleshooting"
        />
      ) : null}

      <ConfigurationIssues runtime={runtime} routes={routes} />
    </div>
  );
}

function PollerPanel({ health }: { health: AntifraudPollerHealth }) {
  const issues: Array<{
    title: string;
    detail: string;
    href: string;
    action: string;
  }> = [];

  if (health.consecutiveFailures > 0) {
    issues.push({
      title: `${health.consecutiveFailures.toLocaleString()} consecutive ingestion failure${health.consecutiveFailures === 1 ? "" : "s"}`,
      detail:
        "New signup and activity assessments may be delayed until the monitor completes a successful tick.",
      href: "/antifraud/guide/troubleshooting",
      action: "Open troubleshooting",
    });
  }
  if (health.signupFailuresPending > 0) {
    issues.push({
      title: `${health.signupFailuresPending.toLocaleString()} signup${health.signupFailuresPending === 1 ? "" : "s"} pending recovery`,
      detail:
        "These accounts do not have a completed automated assessment. Review the cause before retrying or resolving them.",
      href: "/antifraud/settings#signup-recovery",
      action: "Review recovery queue",
    });
  }
  if (health.signupBacklogPossible) {
    issues.push({
      title: "Signup cursor may be behind",
      detail:
        "Recent signups may be waiting to enter assessment even though they are not yet in the recovery queue.",
      href: "/antifraud/guide/troubleshooting",
      action: "Open troubleshooting",
    });
  }
  if (health.status === "degraded" && issues.length === 0) {
    issues.push({
      title: "No recent successful ingestion tick",
      detail:
        "New antifraud assessments may not be arriving. Check the monitor before treating empty review queues as normal.",
      href: "/antifraud/guide/troubleshooting",
      action: "Open troubleshooting",
    });
  }

  if (issues.length > 0) {
    return (
      <div className="space-y-2">
        {issues.map((issue) => (
          <HealthNotice key={issue.title} tone="error" {...issue} />
        ))}
      </div>
    );
  }

  if (health.status === "starting") {
    return (
      <HealthNotice
        tone="warning"
        title="Ingestion is starting"
        detail="The monitor has not completed its first tick yet, so new assessments may take a moment to appear."
        href="/antifraud/guide/troubleshooting"
        action="What to check if this persists"
      />
    );
  }

  if (health.status === "standby") {
    return (
      <HealthNotice
        tone="neutral"
        title="This replica is standing by"
        detail="Another monitor instance owns ingestion. No action is needed while that leader remains healthy."
      />
    );
  }

  return (
    <HealthNotice
      tone="healthy"
      title="Engine healthy"
      detail={
        health.lastSuccessfulTickAt
          ? `Ingestion is current; the last successful tick completed ${formatRelative(health.lastSuccessfulTickAt)}.`
          : "Ingestion is current and no recovery backlog is reported."
      }
    />
  );
}

function ConfigurationIssues({
  runtime,
  routes,
}: {
  runtime: Awaited<ReturnType<typeof getAntifraudRuntimeConfig>>;
  routes: Awaited<ReturnType<typeof getAntifraudNotificationRoutes>>;
}) {
  const missingRoutes = routes.data?.routes.filter((route) => !route.configured) ?? [];
  const fiat = runtime.data?.fiatEligibility;
  const missingFiat = fiat
    ? [
        ["production credential", fiat.prodCredentialConfigured],
        ["production IP allowlist", fiat.prodIpAllowlistConfigured],
        ["development credential", fiat.devCredentialConfigured],
        ["development source", fiat.devSourceConfigured],
        ["development IP allowlist", fiat.devIpAllowlistConfigured],
      ].filter(([, configured]) => !configured)
    : [];

  const hasRouteIssue =
    !routes.configured || routes.error || !routes.data || routes.data.routes.length === 0;
  const hasRuntimeIssue = runtime.configured && (runtime.error || !runtime.data);

  if (!hasRouteIssue && missingRoutes.length === 0 && !hasRuntimeIssue && missingFiat.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <SectionHeading icon={CircleAlert} title="Needs attention" />
      <div className="space-y-2">
        {hasRouteIssue ? (
          <HealthNotice
            tone="warning"
            title={routes.data?.routes.length === 0 ? "No Discord alert routes are configured" : "Discord routing status is unavailable"}
            detail="The dashboard cannot confirm that antifraud events will reach staff in Discord."
            href="/antifraud/discord"
            action="Open Discord routing"
          />
        ) : missingRoutes.length > 0 ? (
          <HealthNotice
            tone="warning"
            title={`${missingRoutes.length.toLocaleString()} Discord alert route${missingRoutes.length === 1 ? " needs" : "s need"} configuration`}
            detail={`${missingRoutes.map((route) => route.label).join(", ")} will not deliver its event families to staff.`}
            href="/antifraud/discord"
            action="Configure routing"
          />
        ) : null}

        {hasRuntimeIssue ? (
          <HealthNotice
            tone="warning"
            title="Runtime configuration status is unavailable"
            detail="The dashboard cannot verify the Fiat eligibility gate, so automatic eligibility should not be assumed healthy."
            href="/antifraud/config"
            action="Open Fiat config"
          />
        ) : missingFiat.length > 0 ? (
          <HealthNotice
            tone="warning"
            title="Fiat eligibility setup is incomplete"
            detail={`Missing ${missingFiat.map(([label]) => label).join(", ")}. Requests for those environments cannot pass the eligibility gate.`}
            href="/antifraud/config"
            action="Open Fiat config"
          />
        ) : null}
      </div>
    </section>
  );
}

const NOTICE_STYLES = {
  healthy: {
    icon: CheckCircle2,
    shell: "border-emerald-500/25 bg-emerald-500/5",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
  neutral: {
    icon: RadioTower,
    shell: "border-border/60 bg-card",
    iconColor: "text-muted-foreground",
  },
  warning: {
    icon: TriangleAlert,
    shell: "border-amber-500/25 bg-amber-500/5",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  error: {
    icon: Clock3,
    shell: "border-rose-500/25 bg-rose-500/5",
    iconColor: "text-rose-600 dark:text-rose-400",
  },
} as const;

function HealthNotice({
  tone,
  title,
  detail,
  href,
  action,
}: {
  tone: keyof typeof NOTICE_STYLES;
  title: string;
  detail: string;
  href?: string;
  action?: string;
}) {
  const style = NOTICE_STYLES[tone];
  const Icon = style.icon;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center",
        style.shell,
      )}
    >
      <Icon className={cn("size-4 shrink-0", style.iconColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
      {href && action && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          render={<HostLink href={href} />}
        >
          {action}
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}
