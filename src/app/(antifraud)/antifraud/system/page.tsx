import Link from "next/link";
import {
  Activity,
  Bot,
  Cable,
  CheckCircle2,
  CircleOff,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getAntifraudPollerHealth,
  getAntifraudRuntimeConfig,
} from "@/lib/antifraud/monitor-api";
import { getDiscordNotificationConfig } from "@/lib/discord-notifications/config";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";

export const metadata = { title: "System · Antifraud" };

export default async function AntifraudSystemPage() {
  await requireAntifraudManagerPage();
  const [poller, runtime, discord] = await Promise.all([
    getAntifraudPollerHealth(),
    getAntifraudRuntimeConfig(),
    getDiscordNotificationConfig().catch(() => null),
  ]);
  const pollerStatus = poller.data?.status ?? (poller.error ? "degraded" : "starting");
  const runtimeReady = Boolean(runtime.data) && !runtime.error;
  const discordReady = discord?.guild.connected === true;

  return (
    <div className="space-y-7">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Poller"
          value={pollerStatus}
          sub={poller.data?.leader ? "active leader" : "standby or starting"}
          icon={Activity}
          accent={pollerStatus === "healthy" ? "emerald" : "amber"}
        />
        <KpiTile
          label="Runtime config"
          value={runtimeReady ? "visible" : "unavailable"}
          sub="presence-only service report"
          icon={ServerCog}
          accent={runtimeReady ? "cyan" : "amber"}
        />
        <KpiTile
          label="Discord"
          value={discordReady ? "connected" : "degraded"}
          sub={discord?.guild.lastSyncedAt ? "channel inventory synced" : "no current sync"}
          icon={Bot}
          accent={discordReady ? "purple" : "amber"}
        />
      </div>

      <section className="space-y-3">
        <SectionHeading icon={Activity} title="API and poller health" />
        <StatusPanel
          ready={pollerStatus === "healthy" || pollerStatus === "standby"}
          title={`Monitor poller is ${pollerStatus}`}
          detail={
            poller.data
              ? `${poller.data.signupsProcessed} signups and ${poller.data.activitiesProcessed} activities in the latest tick. ${poller.data.signupFailuresPending} durable signup failures pending.`
              : poller.configured
                ? "The configured monitor did not return a valid health snapshot."
                : "The monitor URL and read token are not configured."
          }
        >
          {poller.data?.lastSuccessfulTickAt && (
            <Badge variant="outline">
              Last success {new Date(poller.data.lastSuccessfulTickAt).toLocaleString()}
            </Badge>
          )}
          <Button size="sm" variant="outline" render={<Link href="/antifraud/api#signup-failures" />}>
            <RefreshCw />
            Safe recovery controls
          </Button>
        </StatusPanel>
      </section>

      <section id="runtime" className="space-y-3 scroll-mt-20">
        <SectionHeading icon={Cable} title="Sanitized runtime configuration" />
        <p className="text-xs text-muted-foreground">
          Presence only. Values, URLs, tokens, provider payloads, and webhook
          secrets never leave the service.
        </p>
        {runtime.data ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <ConfigGroup
              title="Live transport"
              values={runtime.data.live}
            />
            <ConfigGroup
              title="Signed ingest"
              values={runtime.data.ingest}
            />
            <ConfigGroup
              title="Providers"
              values={runtime.data.providers}
            />
            <ConfigGroup
              title="Discord runtime"
              values={{
                eventQueue: runtime.data.discord.webhookConfigured,
                dashboardLinks: runtime.data.discord.dashboardUrlConfigured,
                supportRecipients:
                  runtime.data.discord.supportRecipientIds.length > 0,
                urgentRecipients:
                  runtime.data.discord.urgentRecipientIds.length > 0,
              }}
            />
            {runtime.data.externalWebappMonitor && (
              <ConfigGroup
                title="Independent webapp monitor"
                values={runtime.data.externalWebappMonitor}
              />
            )}
            {runtime.data.fiatEligibility && (
              <ConfigGroup
                title="Fiat eligibility boundary"
                values={runtime.data.fiatEligibility}
              />
            )}
          </div>
        ) : (
          <StatusPanel
            ready={false}
            title="Runtime visibility unavailable"
            detail={
              runtime.configured
                ? "The monitor rejected, timed out, or returned an invalid presence-only report."
                : "Configure the dashboard monitor URL and read token to view runtime state."
            }
          />
        )}
      </section>

      <section id="discord" className="space-y-3 scroll-mt-20">
        <SectionHeading icon={Bot} title="Discord inventory" />
        <StatusPanel
          ready={discordReady}
          title={discordReady ? discord!.guild.name : "Discord sync unavailable"}
          detail={
            discord
              ? `${discord.channels.length} synced channels, ${discord.routes.filter((route) => route.enabled).length} enabled action routes.`
              : "No raw Discord response is exposed. The approved routing inventory could not be read."
          }
        >
          <Button size="sm" variant="outline" render={<Link href="/antifraud/webhooks" />}>
            Manage approved routes
          </Button>
        </StatusPanel>
      </section>

      <div className="flex gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-cyan-500" />
        Operational retries are offered only for durable signup failures. There
        is no blind provider, Discord, or queue replay button.
      </div>
    </div>
  );
}

function StatusPanel({
  ready,
  title,
  detail,
  children,
}: {
  ready: boolean;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  const Icon = ready ? CheckCircle2 : TriangleAlert;
  return (
    <div className={cn(
      "flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center",
      ready ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/25 bg-amber-500/5",
    )}>
      <Icon className={cn("size-5 shrink-0", ready ? "text-emerald-500" : "text-amber-500")} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

function ConfigGroup({
  title,
  values,
}: {
  title: string;
  values: Record<string, boolean>;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-3 space-y-2">
        {Object.entries(values).map(([key, value]) => (
          <li key={key} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {key.replace(/Configured$/, "").replace(/([a-z])([A-Z])/g, "$1 $2")}
            </span>
            <span className={cn("flex items-center gap-1.5 font-medium", value ? "text-emerald-500" : "text-muted-foreground")}>
              {value ? <CheckCircle2 className="size-3.5" /> : <CircleOff className="size-3.5" />}
              {value ? "Configured" : "Missing"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
