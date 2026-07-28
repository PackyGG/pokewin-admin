import { Suspense } from "react";
import { AlertTriangle, Check, Plug, Settings, Users, X } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ANTIFRAUD_TOGGLE_ROLES,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
} from "@/lib/antifraud/access";
import { getAntifraudRuntimeConfig } from "@/lib/antifraud/monitor-api";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import {
  AccessListEditor,
  RoleAccessToggles,
} from "./_components/access-controls";
import { DiscordConfigSection } from "./_components/discord-config-section";
import {
  SettingsTabNav,
  type SettingsTab,
} from "./_components/settings-tab-nav";

export const metadata = { title: "Settings" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAntifraudManagerPage();
  const requestedTab = (await searchParams).tab;
  const tab: SettingsTab =
    requestedTab === "discord" ? "discord" : "general";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Settings}
          accent="cyan"
          title="Settings"
          subtitle="Access, integrations, and alert delivery"
        />
      </PageHero>

      <SettingsTabNav active={tab} />

      {tab === "discord" ? (
        <Suspense fallback={<Skeleton className="h-[520px] w-full rounded-xl" />}>
          <DiscordConfigSection />
        </Suspense>
      ) : (
        <>
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
            <AccessSection />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
            <IntegrationSection />
          </Suspense>
        </>
      )}
    </div>
  );
}

async function AccessSection() {
  const [settings, userAccess] = await Promise.all([
    getAntifraudAccessSettings().catch(() => null),
    getAntifraudUserAccess().catch(() => ({ allowlist: [], denylist: [] })),
  ]);

  const roles = ANTIFRAUD_TOGGLE_ROLES.map((role) => ({
    role,
    label: role.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    enabled: settings?.[role] ?? false,
  }));

  return (
    <div className="space-y-4">
      <SectionHeading icon={Users} title="Who can enter" />
      <p className="text-xs text-muted-foreground">
        Owners and admins are always in. These toggles open the workspace to
        whole roles; the two lists below override them per person.
      </p>
      <RoleAccessToggles roles={roles} />
      <div className="grid gap-4 md:grid-cols-2">
        <AccessListEditor list="allowlist" initial={userAccess.allowlist} />
        <AccessListEditor list="denylist" initial={userAccess.denylist} />
      </div>
    </div>
  );
}

/**
 * A pair of env vars can be half-set — URL without token, or token without URL.
 * Both halves are required, so a half-configured integration is DEAD, and it
 * must never render the same green as a working one.
 */
type IntegrationStatus = "ready" | "partial" | "missing" | "unknown";

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  ready: "Configured",
  partial: "Half-configured",
  missing: "Not set",
  unknown: "Unavailable",
};

function pairStatus(first: boolean, second: boolean): IntegrationStatus {
  if (first && second) return "ready";
  return first || second ? "partial" : "missing";
}

function reportedStatus(value: boolean | undefined): IntegrationStatus {
  if (value === undefined) return "unknown";
  return value ? "ready" : "missing";
}

async function IntegrationSection() {
  // Presence only — never the value. `Boolean()` on the raw env is the whole
  // check; nothing below ever reads a secret into the render tree.
  const monitorUrl = Boolean(process.env.ANTIFRAUD_MONITOR_API_URL);
  const monitorToken = Boolean(process.env.ANTIFRAUD_MONITOR_API_TOKEN);
  const monitorStatus = pairStatus(monitorUrl, monitorToken);
  const runtime = await getAntifraudRuntimeConfig();
  const runtimeData = runtime.data ?? undefined;
  const liveValues = runtimeData
    ? Object.values(runtimeData.live)
    : undefined;
  const liveStatus: IntegrationStatus = liveValues
    ? liveValues.every(Boolean)
      ? "ready"
      : liveValues.some(Boolean)
        ? "partial"
        : "missing"
    : "unknown";
  const receiverIngestConfigured = Boolean(
    process.env.ANTIFRAUD_INGEST_SECRET,
  );
  const senderIngestValues = runtimeData
    ? Object.values(runtimeData.ingest)
    : undefined;
  const ingestStatus: IntegrationStatus = senderIngestValues
    ? receiverIngestConfigured && senderIngestValues.every(Boolean)
      ? "ready"
      : receiverIngestConfigured || senderIngestValues.some(Boolean)
        ? "partial"
        : "missing"
    : "unknown";

  const integrations: Array<{
    name: string;
    envs: readonly string[];
    status: IntegrationStatus;
    note: string;
  }> = [
    {
      name: "Signed ingest webhook",
      envs: ["ANTIFRAUD_INGEST_URL", "ANTIFRAUD_INGEST_SECRET"],
      status: ingestStatus,
        note:
          ingestStatus === "partial"
            ? "The dashboard receiver or monitor sender is incomplete, so durable delivery is not working end to end."
            : "Shared HMAC delivery from committed monitor risk events, including score-60 signups, into Account Review.",
    },
    {
      name: "Live monitor API",
      envs: ["ANTIFRAUD_MONITOR_API_URL", "ANTIFRAUD_MONITOR_API_TOKEN"],
      status: monitorStatus,
      note:
        monitorStatus === "partial"
          ? `Both halves are required. ${
              monitorUrl
                ? "ANTIFRAUD_MONITOR_API_TOKEN"
                : "ANTIFRAUD_MONITOR_API_URL"
            } is missing, so the Live Monitor and Risk Scoring pages read nothing.`
          : "Base URL plus bearer token for the monitor service. Drives the Live Monitor console and the Risk Scoring page.",
    },
    {
      name: "Monitor live transport",
      envs: ["REDIS_URL", "API_TOKEN", "API_ADMIN_TOKEN", "ALLOWED_ORIGINS"],
      status: liveStatus,
      note:
        liveStatus === "partial"
          ? "The deployed monitor reports an incomplete Redis, token, or exact-origin configuration."
          : "Authoritative status reported by the deployed monitor; values are never returned.",
    },
    {
      name: "Fingerprint Pro",
      envs: ["FINGERPRINT_SECRET_API_KEY"],
      status: reportedStatus(runtimeData?.providers.fingerprintConfigured),
      note: "Provider presence reported by the deployed monitor service.",
    },
    {
      name: "Proxycheck",
      envs: ["PROXYCHECK_API_KEY"],
      status: reportedStatus(runtimeData?.providers.proxycheckConfigured),
      note: "Provider presence reported by the deployed monitor service.",
    },
    {
      name: "Discord alert webhook",
      envs: ["ANTIFRAUD_DISCORD_WEBHOOK_URL"],
      status: reportedStatus(runtimeData?.discord.webhookConfigured),
      note: "Authoritative webhook presence reported by the deployed monitor. Unset means every alert is dropped.",
    },
    {
      name: "Fiat hold Discord webhook",
      envs: ["ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL"],
      status: reportedStatus(
        runtimeData?.discord.withdrawalHoldWebhookConfigured,
      ),
      note: "Dedicated destination for automatic lifetime-deposit withdrawal holds. Delivery retries until Discord accepts it.",
    },
    {
      name: "Fiat problem Discord webhook",
      envs: ["FIAT_ALERT_DISCORD_WEBHOOK_URL"],
      status: reportedStatus(
        runtimeData?.discord.fiatProblemWebhookConfigured,
      ),
      note: "Dedicated destination for failed or abnormal fiat deposits and failed payment-webhook processing. Delivery retries until Discord accepts it.",
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeading icon={Plug} title="Backend integrations" />
      <p className="text-xs text-muted-foreground">
        Presence only. Secrets are never shown on this page.
      </p>

      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {integrations.map((integration) => (
          <li
            key={integration.name}
            className="flex items-start gap-3 px-4 py-3"
          >
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md",
                integration.status === "ready" &&
                  "bg-emerald-500/10 text-emerald-500",
                integration.status === "partial" &&
                  "bg-amber-500/10 text-amber-500",
                integration.status === "unknown" &&
                  "bg-amber-500/10 text-amber-500",
                integration.status === "missing" &&
                  "bg-muted text-muted-foreground",
              )}
            >
              {integration.status === "ready" ? (
                <Check className="size-3" />
              ) : integration.status === "partial" ||
                integration.status === "unknown" ? (
                <AlertTriangle className="size-3" />
              ) : (
                <X className="size-3" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{integration.name}</span>
                {integration.envs.map((env) => (
                  <code
                    key={env}
                    className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {env}
                  </code>
                ))}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {integration.note}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 text-[10px] font-bold uppercase tracking-wide",
                integration.status === "ready" &&
                  "text-emerald-600 dark:text-emerald-400",
                integration.status === "partial" &&
                  "text-amber-600 dark:text-amber-400",
                integration.status === "unknown" &&
                  "text-amber-600 dark:text-amber-400",
                integration.status === "missing" && "text-muted-foreground",
              )}
            >
              {STATUS_LABEL[integration.status]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
