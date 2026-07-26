import { Suspense } from "react";
import { Check, Plug, Settings, Users, X } from "lucide-react";

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
          backHref="/antifraud"
        />
      </PageHero>

      <SettingsTabNav active={tab} />

      {tab === "discord" ? (
        <DiscordConfigSection />
      ) : (
        <>
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
            <AccessSection />
          </Suspense>
          <IntegrationSection />
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

function IntegrationSection() {
  const integrations = [
    {
      name: "Fraud backend stream",
      env: "ANTIFRAUD_WS_URL",
      ready: Boolean(process.env.ANTIFRAUD_WS_URL),
      note: "The WebSocket this app proxies to the browser as a live signal feed.",
    },
    {
      name: "Signed ingest webhook",
      env: "ANTIFRAUD_INGEST_SECRET",
      ready: Boolean(process.env.ANTIFRAUD_INGEST_SECRET),
      note: "Shared HMAC secret for POST /api/antifraud/ingest. Until it is set the endpoint refuses everything.",
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
            key={integration.env}
            className="flex items-start gap-3 px-4 py-3"
          >
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md",
                integration.ready
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {integration.ready ? (
                <Check className="size-3" />
              ) : (
                <X className="size-3" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{integration.name}</span>
                <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {integration.env}
                </code>
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {integration.note}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 text-[10px] font-bold uppercase tracking-wide",
                integration.ready
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              {integration.ready ? "Configured" : "Not set"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
