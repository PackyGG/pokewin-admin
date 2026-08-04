import Link from "next/link";
import { ExternalLink, ShieldCheck, Users } from "lucide-react";

import { getAntifraudRuntimeConfig } from "@/lib/antifraud/monitor-api";
import {
  ANTIFRAUD_TEAM_IDS,
  DISCORD_MENTION_GROUPS,
} from "@/lib/discord-notifications/antifraud-policy";
import { cn } from "@/lib/utils";

/**
 * Operator-facing Discord state read from the deployed monitor's protected,
 * sanitized runtime endpoint. No URL, token, webhook, or provider secret is
 * returned to this app.
 */
/** Rows whose value is a compiled-in code fact; `null` = not determinable here. */
const DELIVERY_FACTS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: "Standard accent", value: "Discord blurple · #5865F2" },
  { label: "Low-risk accent", value: "Green | score 21-49" },
  { label: "High accent", value: "Orange | score 50-69" },
  { label: "Critical / urgent accent", value: "Red · #EF4444" },
  // Replaced with the monitor-reported presence state inside the component.
  { label: "Button destination", value: null },
  { label: "Review trigger", value: "Signup score 50-100 or matched rule" },
  // Was "Not defined yet" while urgent was already live: free-battle risk marks
  // an alert urgent whenever its alert level is critical.
  { label: "Urgent trigger", value: "Critical alert level" },
  { label: "Recipients", value: "Channel selection only" },
];

const TEAM_ROLES = DISCORD_MENTION_GROUPS.map((group) => ({
  label: group.label,
  description: group.description,
  ids: ANTIFRAUD_TEAM_IDS[group.key],
}));

export async function DiscordConfigSection() {
  const runtime = await getAntifraudRuntimeConfig();
  const discord = runtime.data?.discord ?? null;
  const botQueueReady = discord?.botQueueConfigured ?? null;
  const deliveryFacts = DELIVERY_FACTS.map((fact) =>
    fact.label === "Button destination"
      ? {
          ...fact,
          value: discord
            ? discord.dashboardUrlConfigured
              ? "Configured on monitor service"
              : "Not configured"
            : null,
        }
      : fact,
  );

  return (
    <section className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-[#5865F2]/25 bg-card">
        <div className="h-1 bg-[#5865F2]" />
        <div className="grid gap-5 p-5 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-[#5865F2]/10 text-[#5865F2]">
                <ShieldCheck className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold">PackyGG Fraud</p>
                <p className="text-[11px] text-muted-foreground">
                  Discord bot delivery
                </p>
              </div>
              <span
                className={cn(
                  "ml-auto rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  botQueueReady === true
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : botQueueReady === false
                      ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {botQueueReady === true
                  ? "Configured"
                  : botQueueReady === false
                    ? "Not configured"
                    : "Unavailable"}
              </span>
            </div>

            {botQueueReady === false && (
              <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                The deployed monitor cannot reach the bot delivery queue, so
                every antifraud alert is dropped instead of delivered.
              </p>
            )}
            {botQueueReady === null && (
              <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                The monitor configuration could not be read. Delivery status is
                unknown; this page will not guess.
              </p>
            )}

            <div className="mt-5 rounded-lg border border-border/60 bg-muted/20 p-4">
              <span className="inline-flex rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Example alert
              </span>
              <p className="mt-2 text-sm font-semibold">
                {"\u{26A0}\u{FE0F} High-risk signup"}
              </p>
              <div className="mt-4 grid gap-3 text-[11px] sm:grid-cols-2">
                <span>
                  <span className="block text-muted-foreground">{"\u{1F464} Username"}</span>
                  <strong>review_me</strong>
                </span>
                <span>
                  <span className="block text-muted-foreground">{"\u{1F194} User ID"}</span>
                  <code className="font-mono text-[10px]">user-123</code>
                </span>
                <span>
                  <span className="block text-muted-foreground">{"\u{1F4CA} Risk score"}</span>
                  <strong>55 points</strong>
                  <span className="block text-orange-600 dark:text-orange-400">
                    High risk
                  </span>
                </span>
                <span>
                  <span className="block text-muted-foreground">{"\u{1F30D} Location / country"}</span>
                  <strong>Berlin, Germany (DE)</strong>
                </span>
                <span>
                  <span className="block text-muted-foreground">{"\u{1F512} Locks"}</span>
                  <strong>{"\u{2705} None"}</strong>
                </span>
              </div>
              <div className="mt-4 border-t border-border/60 pt-3">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {"\u{1F50E} Why it was flagged"}
                </span>
                <p className="mt-1 text-xs font-semibold">{"\u{2022} +55 \u{00B7} Shared device"}</p>
              </div>
              <span className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-amber-500 px-3 text-xs font-semibold text-white">
                <ExternalLink className="size-3.5" />
                Open Account Review
              </span>
            </div>
          </div>

          <dl className="grid content-start gap-3 text-xs">
            {deliveryFacts.map(({ label, value }) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-border/50 pb-3 last:border-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd
                  className={cn(
                    "text-right font-medium",
                    value === null && "text-muted-foreground italic",
                  )}
                >
                  {value ?? "Unknown · set on the monitor service"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Users className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">Mention groups</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each channel picks the groups it tags on{" "}
              <Link
                href="/antifraud/discord"
                className="font-medium underline underline-offset-2"
              >
                Discord Routing
              </Link>
              . These are the members of each group.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {TEAM_ROLES.map((role) => (
            <div
              key={role.label}
              className="rounded-lg border border-border/50 bg-muted/20 p-3"
            >
              <p className="text-xs font-semibold">{role.label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {role.description}
              </p>
              <ul className="mt-2 space-y-2">
                {role.ids.map((id) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-card px-3 py-2"
                  >
                    <code className="min-w-0 font-mono text-xs">{id}</code>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {role.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck className="size-3.5" />
        </span>
        <div>
          <p className="text-sm font-semibold">
            Mention text is built by the queue, never by alert content
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Tags are resolved when the alert is queued, from the destination
            channel&apos;s selected groups and the member ids above — never from
            anything inside the alert. Each job carries a matching{" "}
            <code className="font-mono">allowed_mentions</code> allowlist with{" "}
            <code className="font-mono">parse: []</code>, so no alert can produce
            an @everyone, @here, or role ping. Channels under Errors and KYC post
            silently and tag nobody.
          </p>
        </div>
      </div>
    </section>
  );
}
