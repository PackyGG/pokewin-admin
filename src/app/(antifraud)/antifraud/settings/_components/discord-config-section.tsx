import { BellRing, ExternalLink, ShieldCheck, Siren, Users } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { channelConfigStatus } from "@/lib/staff/channels";
import { cn } from "@/lib/utils";

/**
 * Discord alert delivery — operator-facing status.
 *
 * HONESTY RULE FOR THIS PANEL: nothing here may claim a green "configured"
 * state that the server has not actually checked. Readiness comes from
 * `channelConfigStatus()` (presence of `ANTIFRAUD_DISCORD_WEBHOOK_URL`) — the
 * exact same env var `DiscordAlerts.send()` bails on in the monitor service —
 * so this tab can no longer contradict the General tab. Anything the admin
 * genuinely cannot determine server-side (the monitor's own
 * `ANTIFRAUD_DASHBOARD_URL`) renders as UNKNOWN, never as a green fact.
 *
 * The webhook URL itself is never rendered, logged or returned — presence only.
 */

/**
 * Single admin-side copy of the mention list compiled into the monitor
 * (`services/antifraud-monitor/src/discord.ts` → `SUPPORT_USER_IDS` /
 * `URGENT_USER_IDS`). The monitor is a separate deployable package and is
 * excluded from this app's tsconfig, so its module cannot be imported here.
 * These arrays are therefore labelled in the UI as a MIRROR of the deployed
 * list, not as live-verified delivery state.
 */
const SUPPORT_IDS = [
  "1302882250391818311",
  "976564661820481606",
  "620373461256110112",
] as const;

const URGENT_IDS = [
  "934854938641715240",
  "660132586630414338",
  "276098533629755392",
  "188051599099297802",
] as const;

/** Rows whose value is a compiled-in code fact; `null` = not determinable here. */
const DELIVERY_FACTS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: "Standard accent", value: "Discord blurple · #5865F2" },
  { label: "Urgent accent", value: "Red · #EF4444" },
  // ANTIFRAUD_DASHBOARD_URL lives in the monitor service's own environment.
  // The admin has no way to read it, so it must not be printed as fact.
  { label: "Button destination", value: null },
  { label: "Automatic trigger", value: "Matched antifraud rules" },
  { label: "Urgent trigger", value: "Not defined yet" },
];

function RecipientList({
  title,
  description,
  ids,
  urgent = false,
}: {
  title: string;
  description: string;
  ids: readonly string[];
  urgent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-start gap-3">
        <span
          className={
            urgent
              ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-500"
              : "flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#5865F2]/10 text-[#5865F2]"
          }
        >
          {urgent ? <Siren className="size-4" /> : <Users className="size-4" />}
        </span>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {ids.map((id) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
          >
            {/* Neutral marker: the admin cannot verify a recipient is reachable,
                so this must not read as a live "delivering" indicator. */}
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            <code className="font-mono text-xs">{id}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DiscordConfigSection() {
  const webhookReady = channelConfigStatus().discord;

  return (
    <section className="space-y-5">
      <div>
        <SectionHeading icon={BellRing} title="Discord alerts" />
        <p className="mt-2 text-xs text-muted-foreground">
          Readiness below is read server-side from{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px]">
            ANTIFRAUD_DISCORD_WEBHOOK_URL
          </code>
          . The webhook URL and the shared secret are never shown on this page.
        </p>
      </div>

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
                  Discord webhook identity
                </p>
              </div>
              <span
                className={cn(
                  "ml-auto rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide",
                  webhookReady
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
                )}
              >
                {webhookReady ? "Configured" : "Not configured"}
              </span>
            </div>

            {!webhookReady && (
              <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                No webhook URL is set on this deployment, so every antifraud
                alert is dropped instead of delivered.
              </p>
            )}

            <div className="mt-5 rounded-lg border border-border/60 bg-muted/20 p-4">
              <span className="inline-flex rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                Example alert
              </span>
              <p className="mt-2 text-sm font-semibold">
                Rule matched: Example rule
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                A monitored account matched an antifraud rule and needs support
                review.
              </p>
              <div className="mt-4 flex flex-wrap gap-4 text-[11px]">
                <span>
                  <span className="block text-muted-foreground">Risk score</span>
                  <strong>60</strong>
                </span>
                <span>
                  <span className="block text-muted-foreground">Trigger</span>
                  <strong>example-rule</strong>
                </span>
                <span>
                  <span className="block text-muted-foreground">Priority</span>
                  <strong>Standard</strong>
                </span>
              </div>
              <span className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5865F2] px-3 text-xs font-semibold text-white">
                <ExternalLink className="size-3.5" />
                Open Antifraud
              </span>
            </div>
          </div>

          <dl className="grid content-start gap-3 text-xs">
            {DELIVERY_FACTS.map(({ label, value }) => (
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

      <div className="grid gap-4 lg:grid-cols-2">
        <RecipientList
          title="Always tag support"
          description="Mentioned on every antifraud rule alert."
          ids={SUPPORT_IDS}
        />
        <RecipientList
          title="Urgent escalation"
          description="Added only when a future trigger is explicitly marked urgent."
          ids={URGENT_IDS}
          urgent
        />
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ShieldCheck className="size-3.5" />
        </span>
        <div>
          <p className="text-sm font-semibold">Mention scope is pinned in code</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The alert payload sends <code className="font-mono">allowed_mentions</code>{" "}
            restricted to exactly the ids above, so alert text cannot create
            extra user, role, here, or everyone pings. Both lists mirror the
            monitor service&apos;s compiled-in recipients — the deployed service
            is the source of truth.
          </p>
        </div>
      </div>
    </section>
  );
}
