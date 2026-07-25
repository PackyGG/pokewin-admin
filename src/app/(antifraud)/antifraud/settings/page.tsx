import { Suspense } from "react";
import Link from "next/link";
import { Check, Globe, Plug, Settings, Users, X } from "lucide-react";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ANTIFRAUD_TOGGLE_ROLES,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
} from "@/lib/antifraud/access";
import { channelConfigStatus } from "@/lib/antifraud/channels";
import { DEFAULT_ANTIFRAUD_HOST, antifraudHosts } from "@/lib/antifraud/host";
import {
  AccessListEditor,
  RoleAccessToggles,
} from "./_components/access-controls";

export const metadata = { title: "Workspace Settings" };

/**
 * Antifraud → Manage → Workspace Settings. OWNER / ADMIN ONLY.
 *
 * Two things live here:
 *
 *  1. ACCESS — who can enter the workspace (per-role toggles + per-username
 *     overrides). Owners and admins are always in and can never be denied.
 *
 *  2. INTEGRATION STATUS — whether the deployment has the credentials for
 *     Discord pings, Telegram pings, the fraud-backend WebSocket and the signed
 *     ingest webhook, plus which hostnames serve this app.
 *
 * The status panel reports PRESENCE ONLY. No token, URL or secret is ever read
 * into the page — an operator needs to know whether a thing is configured, not
 * what it is configured to.
 */

export default async function WorkspaceSettingsPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Settings}
          accent="cyan"
          title="Workspace Settings"
          subtitle="Who gets in, and what this deployment is wired to"
          backHref="/antifraud"
        />
      </PageHero>

      <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
        <AccessSection />
      </Suspense>

      <IntegrationSection />
    </div>
  );
}

// ─── Access ───────────────────────────────────────────────────────────

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

// ─── Integrations ─────────────────────────────────────────────────────

function IntegrationSection() {
  const channels = channelConfigStatus();
  const hosts = antifraudHosts();

  const integrations = [
    {
      name: "Discord pings",
      env: "ANTIFRAUD_DISCORD_WEBHOOK_URL",
      ready: channels.discord,
      note: "A Discord channel webhook. Staff alerts arrive as a mention of their own user id.",
    },
    {
      name: "Telegram pings",
      env: "ANTIFRAUD_TELEGRAM_BOT_TOKEN",
      ready: channels.telegram,
      note: "A BotFather token. Staff message the bot once so it may DM them.",
    },
    {
      name: "Fraud backend stream",
      env: "ANTIFRAUD_WS_URL",
      ready: Boolean(process.env.ANTIFRAUD_WS_URL),
      note: "The WebSocket this app proxies to the browser as a live signal feed. Optional — the workspace runs without it.",
    },
    {
      name: "Signed ingest webhook",
      env: "ANTIFRAUD_INGEST_SECRET",
      ready: Boolean(process.env.ANTIFRAUD_INGEST_SECRET),
      note: "Shared HMAC secret for POST /api/antifraud/ingest. Until it is set the endpoint refuses everything (fail-closed).",
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeading icon={Plug} title="Backend integrations" />
      <p className="text-xs text-muted-foreground">
        Presence only — no secret is ever read into this page. Everything here
        is optional: with none of it configured the workspace still runs
        entirely off the dashboard database.
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

      <div className="space-y-2 rounded-xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Hostnames</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Requests arriving on any of these hosts are served this workspace at
          their root — <code className="font-mono">{hosts[0]}/reviews</code>{" "}
          renders the same page as{" "}
          <code className="font-mono">/antifraud/reviews</code> here. Nothing
          happens until the DNS record and the Vercel domain exist; add more
          hosts with <code className="font-mono">NEXT_PUBLIC_ANTIFRAUD_HOSTS</code>.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {hosts.map((host) => (
            <li
              key={host}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                host === DEFAULT_ANTIFRAUD_HOST
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
                  : "border-border/60 bg-muted/40 text-muted-foreground",
              )}
            >
              {host}
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          To share one login across the apex domain and this sub-domain, set{" "}
          <code className="font-mono">SESSION_COOKIE_DOMAIN=.packydash.com</code>
          . Leaving it unset keeps the session cookie host-only, exactly as it is
          today.
        </p>
      </div>

      <div className="rounded-xl border border-border/60 bg-card p-4">
        <span className="text-sm font-semibold">Quizzes</span>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Quiz authoring lives on its own page.
        </p>
        <Link
          href="/antifraud/settings/quizzes"
          className="mt-2 inline-block text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-400"
        >
          Open the Quiz Manager →
        </Link>
      </div>
    </div>
  );
}
