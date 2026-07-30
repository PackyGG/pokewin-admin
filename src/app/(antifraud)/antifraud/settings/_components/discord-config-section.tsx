import { BellRing, ExternalLink, ShieldCheck, Siren, Users } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { getAntifraudRuntimeConfig } from "@/lib/antifraud/monitor-api";
import { cn } from "@/lib/utils";

/**
 * Operator-facing Discord state read from the deployed monitor's protected,
 * sanitized runtime endpoint. No URL, token, webhook, or provider secret is
 * returned to this app.
 */
/** Rows whose value is a compiled-in code fact; `null` = not determinable here. */
const DELIVERY_FACTS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: "Standard accent", value: "Discord blurple · #5865F2" },
  { label: "Review accent", value: "Amber | score 21-49" },
  { label: "High accent", value: "Orange | score 50-69" },
  { label: "Critical / urgent accent", value: "Red · #EF4444" },
  // Replaced with the monitor-reported presence state inside the component.
  { label: "Button destination", value: null },
  { label: "Automatic trigger", value: "Signup score 50+ or matched rule" },
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
  ids: readonly string[] | null;
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
        {ids ? (
          ids.map((id) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
            >
              <span className="size-1.5 rounded-full bg-muted-foreground/40" />
              <code className="font-mono text-xs">{id}</code>
            </li>
          ))
        ) : (
          <li className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Unavailable from the monitor service
          </li>
        )}
      </ul>
    </div>
  );
}

export async function DiscordConfigSection() {
  const runtime = await getAntifraudRuntimeConfig();
  const discord = runtime.data?.discord ?? null;
  const webhookReady = discord?.webhookConfigured ?? null;
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
      <div>
        <SectionHeading icon={BellRing} title="Discord alerts" />
        <p className="mt-2 text-xs text-muted-foreground">
          Readiness and recipients come from the deployed monitor service. The
          webhook URL, shared secret, and provider credentials are never returned.
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
                  "ml-auto rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                  webhookReady === true
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : webhookReady === false
                      ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {webhookReady === true
                  ? "Configured"
                  : webhookReady === false
                    ? "Not configured"
                    : "Unavailable"}
              </span>
            </div>

            {webhookReady === false && (
              <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                No webhook URL is set on the deployed monitor, so every
                antifraud alert is dropped instead of delivered.
              </p>
            )}
            {webhookReady === null && (
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
                High-risk signup detected
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                This account crossed the automated signup review threshold and
                needs a staff decision.
              </p>
              <div className="mt-4 grid gap-3 text-[11px] sm:grid-cols-3">
                <span>
                  <span className="block text-muted-foreground">Account</span>
                  <strong>review_me</strong>
                  <code className="block font-mono text-[10px] text-muted-foreground">
                    user-123
                  </code>
                </span>
                <span>
                  <span className="block text-muted-foreground">Risk score</span>
                  <strong>55 points</strong>
                  <span className="block text-orange-600 dark:text-orange-400">
                    High risk
                  </span>
                </span>
                <span>
                  <span className="block text-muted-foreground">Trigger</span>
                  <strong>Signup score 50+</strong>
                </span>
              </div>
              <div className="mt-4 border-t border-border/60 pt-3">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Why it was flagged
                </span>
                <p className="mt-1 text-xs font-semibold">+55 | Shared device</p>
                <p className="text-[11px] text-muted-foreground">
                  Three accounts share this device.
                </p>
              </div>
              <span className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-amber-500 px-3 text-xs font-semibold text-white">
                <ExternalLink className="size-3.5" />
                Review case
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

      <div className="grid gap-4 lg:grid-cols-2">
        <RecipientList
          title="Always tag support"
          description="Mentioned on every signup and rule alert."
          ids={discord?.supportRecipientIds ?? null}
        />
        <RecipientList
          title="Urgent alerts"
          description="Added only when a future trigger is explicitly marked urgent."
          ids={discord?.urgentRecipientIds ?? null}
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
            restricted to exactly the ids reported above, so alert text cannot
            create extra user, role, here, or everyone pings. The deployed
            service is the source of truth.
          </p>
        </div>
      </div>
    </section>
  );
}
