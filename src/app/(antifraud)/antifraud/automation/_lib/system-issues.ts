import type {
  AntifraudPollerHealth,
  AntifraudRuntimeConfig,
  AntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import type { DiscordNotificationConfig } from "@/lib/discord-notifications/config";

/**
 * SYSTEM ISSUE DETECTION — the "logic" half of the Automation control center.
 *
 * The old Automation page rendered a static map of links: an operator could
 * read what the engine *can* do, but never what is actually BROKEN right now.
 * This module turns the same reads (monitor runtime config, poller health,
 * scoring config, Discord routing) into a ranked, actionable defect list, so
 * the page can answer "is the fraud engine fully wired, and if not, what do I
 * click?" without an operator cross-reading four other pages.
 *
 * Pure + synchronous on purpose: every input is already fetched by the caller,
 * so this is unit-reasonable and can never add a request to the page.
 */

export type IssueSeverity = "critical" | "warning";

export type SystemIssue = {
  /** Stable key — also the React key, so it must be unique per issue. */
  id: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  /** Where the operator goes to fix it. */
  href: string;
  actionLabel: string;
};

export type SystemIssueInput = {
  /** Both halves of the monitor API credential pair are present. */
  monitorApiUrlConfigured: boolean;
  monitorApiTokenConfigured: boolean;
  /** The dashboard's receiving half of the signed ingest webhook. */
  ingestSecretConfigured: boolean;
  runtime: AntifraudRuntimeConfig | null;
  runtimeUnavailable: boolean;
  poller: AntifraudPollerHealth | null;
  pollerUnavailable: boolean;
  scoring: AntifraudScoringConfig | null;
  scoringUnavailable: boolean;
  discord: DiscordNotificationConfig | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  fingerprintConfigured: "Fingerprint Pro Plus",
  proxycheckConfigured: "ProxyCheck v3 Pro",
  abstractIpConfigured: "Abstract IP Intelligence",
  abstractEmailConfigured: "Abstract Email Reputation",
  opportifyConfigured: "Opportify Full Fraud Check",
  maxmindFactorsConfigured: "MaxMind minFraud Factors",
  maxmindAlertsConfigured: "MaxMind risk-score alerts",
};

const LIVE_TRANSPORT_LABELS: Record<string, string> = {
  redisConfigured: "Redis",
  readTokenConfigured: "read token",
  adminTokenConfigured: "admin token",
  exactOriginsConfigured: "exact origins",
};

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  warning: 1,
};

function list(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * Ranked defect list — critical first, then warnings, stable inside a band.
 * An empty array means every wired-up check passed, which the page renders as
 * an explicit all-clear rather than as "no data".
 */
export function collectSystemIssues(input: SystemIssueInput): SystemIssue[] {
  const issues: SystemIssue[] = [];

  // ── Transport: nothing else is trustworthy if the monitor is unreachable ──
  const monitorPairComplete =
    input.monitorApiUrlConfigured && input.monitorApiTokenConfigured;
  if (!input.monitorApiUrlConfigured && !input.monitorApiTokenConfigured) {
    issues.push({
      id: "monitor-api-missing",
      severity: "critical",
      title: "Monitor API is not configured",
      detail:
        "Neither ANTIFRAUD_MONITOR_API_URL nor ANTIFRAUD_MONITOR_API_TOKEN is set, so scoring, point flows, the event catalog and the live console all read nothing.",
      href: "/antifraud/settings",
      actionLabel: "Inspect integrations",
    });
  } else if (!monitorPairComplete) {
    issues.push({
      id: "monitor-api-partial",
      severity: "critical",
      title: "Monitor API is half-configured",
      detail: `Both halves are required. ${
        input.monitorApiUrlConfigured
          ? "ANTIFRAUD_MONITOR_API_TOKEN"
          : "ANTIFRAUD_MONITOR_API_URL"
      } is missing, so every monitor-backed page renders empty.`,
      href: "/antifraud/settings",
      actionLabel: "Inspect integrations",
    });
  }

  if (monitorPairComplete && input.runtimeUnavailable) {
    issues.push({
      id: "runtime-unreadable",
      severity: "critical",
      title: "The monitor is not answering",
      detail:
        "The deployed monitor did not return its runtime configuration, so provider and transport status below cannot be trusted.",
      href: "/antifraud/settings",
      actionLabel: "Inspect integrations",
    });
  }

  const runtime = input.runtime;
  if (runtime) {
    const deadTransport = Object.entries(runtime.live)
      .filter(([, ok]) => !ok)
      .map(([key]) => LIVE_TRANSPORT_LABELS[key] ?? key);
    if (deadTransport.length > 0) {
      issues.push({
        id: "live-transport-incomplete",
        severity: "critical",
        title: "Live transport is incomplete",
        detail: `The deployed monitor reports a missing ${list(deadTransport)}. The live event stream degrades or stops without it.`,
        href: "/antifraud/settings",
        actionLabel: "Inspect integrations",
      });
    }

    const ingestReady =
      input.ingestSecretConfigured &&
      runtime.ingest.endpointConfigured &&
      runtime.ingest.secretConfigured;
    if (!ingestReady) {
      issues.push({
        id: "ingest-incomplete",
        severity: "critical",
        title: "Signed ingest is not working end to end",
        detail:
          "Committed monitor risk events reach Account Review over an HMAC-signed webhook. With either the sender or the receiver half missing, cases stop arriving in the dashboard.",
        href: "/antifraud/settings",
        actionLabel: "Inspect integrations",
      });
    }

    const missingProviders = Object.entries(runtime.providers)
      .filter(([, ok]) => !ok)
      .map(([key]) => PROVIDER_LABELS[key] ?? key);
    if (missingProviders.length > 0) {
      issues.push({
        id: "providers-missing",
        severity: "warning",
        title: `${missingProviders.length} signup provider${missingProviders.length === 1 ? "" : "s"} not configured`,
        detail: `${list(missingProviders)} contribute no evidence, so signup assessments score on fewer signals than the weights assume.`,
        href: "/antifraud/settings",
        actionLabel: "Inspect integrations",
      });
    }

    // `botQueueConfigured` is optional: an older monitor build omits it, and
    // "unknown" must never be reported as "off".
    if (runtime.discord.botQueueConfigured === false) {
      issues.push({
        id: "discord-bot-queue",
        severity: "critical",
        title: "Discord delivery is not configured",
        detail:
          "Every antifraud alert is queued for the Discord bot. With the queue unconfigured, no routed alert is posted anywhere.",
        href: "/antifraud/settings?tab=discord",
        actionLabel: "Open Discord settings",
      });
    }
  }

  // ── Ingestion loop health ────────────────────────────────────────────────
  if (monitorPairComplete && input.pollerUnavailable) {
    issues.push({
      id: "poller-unreadable",
      severity: "warning",
      title: "Poller health is unreadable",
      detail:
        "The monitor did not report its ingestion loop status, so a stalled signup poller would go unnoticed.",
      href: "/antifraud/settings?tab=health",
      actionLabel: "Open engine health",
    });
  }

  const poller = input.poller;
  if (poller) {
    if (poller.status === "degraded") {
      issues.push({
        id: "poller-degraded",
        severity: "critical",
        title: "The ingestion poller is degraded",
        detail:
          poller.lastError ??
          "The monitor reports a degraded ingestion loop. New signups and live activity may not be assessed.",
        href: "/antifraud/settings?tab=health",
        actionLabel: "Open engine health",
      });
    } else if (poller.consecutiveFailures > 0) {
      issues.push({
        id: "poller-failures",
        severity: "warning",
        title: `Poller has ${poller.consecutiveFailures} consecutive failure${poller.consecutiveFailures === 1 ? "" : "s"}`,
        detail:
          poller.lastError ??
          "The ingestion loop is retrying. Sustained failures delay every signup assessment.",
        href: "/antifraud/settings?tab=health",
        actionLabel: "Open engine health",
      });
    }

    if (poller.signupFailuresPending > 0) {
      issues.push({
        id: "signup-failures-pending",
        severity: "warning",
        title: `${poller.signupFailuresPending} signup${poller.signupFailuresPending === 1 ? "" : "s"} pending recovery`,
        detail:
          "These accounts failed assessment and are queued for retry. Until they recover they carry no risk score.",
        href: "/antifraud/settings?tab=health",
        actionLabel: "Open engine health",
      });
    }

    if (poller.signupBacklogPossible) {
      issues.push({
        id: "signup-backlog",
        severity: "warning",
        title: "A signup backlog is possible",
        detail:
          "The poller cursor is lagging behind new signups, so recent accounts may not be assessed yet.",
        href: "/antifraud/settings?tab=health",
        actionLabel: "Open engine health",
      });
    }
  }

  // ── Detection configuration ──────────────────────────────────────────────
  if (monitorPairComplete && input.scoringUnavailable) {
    issues.push({
      id: "scoring-unreadable",
      severity: "warning",
      title: "Scoring configuration is unreadable",
      detail:
        "Risk weights and point flows could not be loaded, so this page cannot confirm which detections are active.",
      href: "/antifraud/points",
      actionLabel: "Open rules & scoring",
    });
  }

  const disabledFlows =
    input.scoring?.behaviorRules.filter((rule) => !rule.enabled) ?? [];
  if (disabledFlows.length > 0) {
    issues.push({
      id: "flows-disabled",
      severity: "warning",
      title: `${disabledFlows.length} point flow${disabledFlows.length === 1 ? " is" : "s are"} disabled`,
      detail: `${list(disabledFlows.map((rule) => rule.name))} ${disabledFlows.length === 1 ? "is" : "are"} configured but not evaluated during live monitoring.`,
      href: "/antifraud/points?tab=flows",
      actionLabel: "Open flow builder",
    });
  }

  // ── Alert delivery coverage ──────────────────────────────────────────────
  if (!input.discord) {
    issues.push({
      id: "discord-config-unreadable",
      severity: "warning",
      title: "Discord routing is unreadable",
      detail:
        "The routing configuration could not be loaded, so alert coverage cannot be verified.",
      href: "/antifraud/discord",
      actionLabel: "Open Discord routing",
    });
  } else {
    const routedKeys = new Set(
      input.discord.routes
        .filter((route) => route.enabled)
        .map((route) => route.eventKey),
    );
    const unrouted = input.discord.events.filter(
      (event) => event.enabled && !routedKeys.has(event.key),
    );
    if (unrouted.length > 0) {
      issues.push({
        id: "alerts-unrouted",
        severity: "warning",
        title: `${unrouted.length} enabled alert${unrouted.length === 1 ? "" : "s"} have no channel`,
        detail: `${list(unrouted.slice(0, 4).map((event) => event.label))}${unrouted.length > 4 ? ` and ${unrouted.length - 4} more` : ""} fire but land nowhere.`,
        href: "/antifraud/discord",
        actionLabel: "Assign channels",
      });
    }
  }

  return issues.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
