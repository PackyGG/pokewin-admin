import { Suspense, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Gauge,
  ListChecks,
  RadioTower,
  Settings2,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAntifraudEventCatalog,
  getAntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import {
  getDiscordNotificationConfig,
  type DiscordNotificationConfig,
} from "@/lib/discord-notifications/config";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { AUTOMATION_FLOWS, type AutomationLink } from "./automation-catalog";

export const metadata = { title: "Automation & Rules · Antifraud" };

export default async function AntifraudAutomationPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-600 dark:text-cyan-400">
          Control center
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Automation & Rules
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          One map for detection, scoring, automatic account actions, review
          queues, and Discord delivery. Editable controls link to the live owner
          of each setting; fixed safety behavior is labelled clearly.
        </p>
      </div>

      <Pipeline />

      <Suspense fallback={<AutomationSkeleton />}>
        <AutomationData />
      </Suspense>
    </div>
  );
}

async function AutomationData() {
  const [scoring, events, discord] = await Promise.all([
    getAntifraudScoringConfig(),
    getAntifraudEventCatalog(),
    readDiscordConfig(),
  ]);

  const rules = scoring.data?.behaviorRules ?? [];
  const scoringReady = scoring.configured && !scoring.error && scoring.data !== null;
  const eventsReady = events.configured && !events.error;
  const activeRules = rules.filter((rule) => rule.enabled);
  const liveEvents = events.data.filter((event) => event.status === "live");
  const enabledDiscordEvents = discord?.events.filter((event) => event.enabled) ?? [];
  const activeDiscordRoutes =
    discord?.routes.filter((route) => route.enabled) ?? [];
  const routedKeys = new Set(activeDiscordRoutes.map((route) => route.eventKey));
  const unroutedEvents = enabledDiscordEvents.filter(
    (event) => !routedKeys.has(event.key),
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Live event sources"
          value={eventsReady ? liveEvents.length.toLocaleString() : "—"}
          sub={eventsReady ? `${events.data.length - liveEvents.length} planned` : "Monitor unavailable"}
          icon={RadioTower}
          accent="cyan"
        />
        <KpiTile
          label="Active point flows"
          value={scoringReady ? activeRules.length.toLocaleString() : "—"}
          sub={scoringReady ? `${rules.length} total flows` : "Monitor unavailable"}
          icon={Workflow}
          accent="emerald"
        />
        <KpiTile
          label="Discord actions"
          value={discord ? enabledDiscordEvents.length.toLocaleString() : "—"}
          sub={discord ? `${routedKeys.size} assigned` : "Routing unavailable"}
          icon={BellRing}
          accent="blue"
        />
        <KpiTile
          label="Unrouted alerts"
          value={discord ? unroutedEvents.length.toLocaleString() : "—"}
          sub={
            !discord
              ? "Routing unavailable"
              : unroutedEvents.length === 0
                ? "All actions covered"
                : "Needs a channel"
          }
          icon={discord && unroutedEvents.length === 0 ? CheckCircle2 : CircleAlert}
          accent={discord && unroutedEvents.length === 0 ? "emerald" : "amber"}
        />
      </div>

      <EditableControls />
      <DynamicFlows rules={rules} available={scoringReady} />
      <BuiltInFlows />
      <DiscordCoverage config={discord} />
    </div>
  );
}

async function readDiscordConfig(): Promise<DiscordNotificationConfig | null> {
  try {
    return await getDiscordNotificationConfig();
  } catch (error) {
    console.error("[antifraud-automation] Discord config read failed:", error);
    return null;
  }
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

function EditableControls() {
  const controls = [
    {
      title: "Risk scoring",
      text: "Point weights for signup, provider, activity, network, and creator signals.",
      href: "/antifraud/points?tab=scoring",
      label: "Edit points",
      icon: Gauge,
    },
    {
      title: "Point flows",
      text: "Ordered live-event sequences, exclusions, windows, score deltas, and manual review.",
      href: "/antifraud/points?tab=flows",
      label: "Edit flows",
      icon: Workflow,
    },
    {
      title: "Discord routing",
      text: "Assign every alert action to one channel and choose which staff groups it tags.",
      href: "/antifraud/discord",
      label: "Edit routes",
      icon: BellRing,
    },
    {
      title: "Fiat review",
      text: "Control the global backend-owned automatic Fiat credit switch without changing per-user overrides.",
      href: "/antifraud/config",
      label: "Edit Fiat config",
      icon: Settings2,
    },
    {
      title: "Detection inputs",
      text: "Browse the canonical live and planned event vocabulary used by point flows.",
      href: "/antifraud/events",
      label: "Browse events",
      icon: Activity,
    },
    {
      title: "Providers & transport",
      text: "Inspect configured providers, live transport, signed ingest, Fiat eligibility, and Discord queue health.",
      href: "/antifraud/settings",
      label: "Inspect integrations",
      icon: ListChecks,
    },
  ];

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Settings2}
        title="Everything you can configure"
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {controls.map((control) => {
          const Icon = control.icon;
          return (
            <div
              key={control.title}
              className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card p-4"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-cyan-600 dark:text-cyan-400" aria-hidden />
                <h2 className="text-sm font-semibold">{control.title}</h2>
              </div>
              <p className="mt-2 flex-1 text-xs leading-5 text-muted-foreground">
                {control.text}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 w-fit"
                render={<HostLink href={control.href} />}
              >
                {control.label}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DynamicFlows({
  rules,
  available,
}: {
  rules: NonNullable<Awaited<ReturnType<typeof getAntifraudScoringConfig>>["data"]>["behaviorRules"];
  available: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Workflow}
        title="Editable point flows"
        action={
          <Button
            size="sm"
            variant="outline"
            render={<HostLink href="/antifraud/points?tab=flows" />}
          >
            Open flow editor
          </Button>
        }
      />
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        {!available ? (
          <EmptyState text="The live point-flow configuration is unavailable." />
        ) : rules.length === 0 ? (
          <EmptyState text="No point flows are configured." />
        ) : (
          <div className="divide-y divide-border/60">
            {rules.map((rule) => (
              <article
                key={rule.id}
                className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{rule.name}</h3>
                    <StatusBadge enabled={rule.enabled} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {rule.description || "No description."}
                  </p>
                  <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground">
                    {rule.sequence.join(" → ")}
                  </p>
                </div>
                <div className="text-xs text-muted-foreground">
                  <p>
                    Window: <strong className="text-foreground">{rule.window_seconds}s</strong>
                  </p>
                  <p className="mt-1">
                    Outcome: <strong className="text-foreground">{rule.score_delta > 0 ? "+" : ""}{rule.score_delta} points + manual review</strong>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  render={<HostLink href="/antifraud/points?tab=flows" />}
                >
                  Edit
                </Button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BuiltInFlows() {
  return (
    <section className="space-y-3">
      <SectionHeading icon={ListChecks} title="Built-in detection and actions" />
      <div className="space-y-3">
        {AUTOMATION_FLOWS.map((flow) => {
          const Icon = flow.icon;
          return (
            <article
              key={flow.name}
              className="rounded-xl border border-border/60 bg-card p-4"
            >
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">{flow.name}</h3>
                      <p className="text-[11px] text-muted-foreground">{flow.scope}</p>
                    </div>
                    <ModeBadge mode={flow.mode} />
                  </div>
                  <p className="mt-3 max-w-4xl text-xs leading-5 text-muted-foreground">
                    {flow.trigger}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {flow.controls.map((control) => (
                    <ControlLink key={`${flow.name}-${control.href}`} control={control} />
                  ))}
                </div>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Actions
                  </p>
                  <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                    {flow.actions.map((action) => (
                      <li key={action} className="flex gap-2 text-xs leading-5">
                        <CheckCircle2 className="mt-1 size-3 shrink-0 text-cyan-600 dark:text-cyan-400" aria-hidden />
                        <span>{action}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Discord actions
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {flow.discordEvents.length > 0 ? (
                      flow.discordEvents.map((event) => (
                        <code
                          key={event}
                          className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground"
                        >
                          {event}
                        </code>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No dedicated Discord action.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DiscordCoverage({
  config,
}: {
  config: DiscordNotificationConfig | null;
}) {
  const channelById = new Map(
    config?.channels.map((channel) => [channel.id, channel.name]) ?? [],
  );
  const channelNamesByEvent = new Map<string, string[]>();
  for (const route of config?.routes ?? []) {
    if (!route.enabled) continue;
    const names = channelNamesByEvent.get(route.eventKey) ?? [];
    names.push(channelById.get(route.channelId) ?? route.channelId);
    channelNamesByEvent.set(route.eventKey, names);
  }

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={BellRing}
        title="Discord action coverage"
        action={
          <Button
            size="sm"
            variant="outline"
            render={<HostLink href="/antifraud/discord" />}
          >
            Edit routing
          </Button>
        }
      />
      {!config ? (
        <EmptyState text="Discord routing configuration is unavailable." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="divide-y divide-border/60">
            {config.events
              .filter((event) => event.enabled)
              .map((event) => {
                const channelNames = channelNamesByEvent.get(event.key) ?? [];
                return (
                  <article
                    key={event.key}
                    className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)_auto] md:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium">{event.label}</h3>
                        <Badge variant="outline" className="h-5 text-[10px]">
                          {event.category}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {event.description}
                      </p>
                      <code className="mt-1 block truncate text-[10px] text-muted-foreground">
                        {event.key}
                      </code>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {channelNames.length > 0 ? (
                        channelNames.map((channel) => (
                          <Badge key={channel} variant="secondary">
                            #{channel}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                          No channel assigned
                        </span>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "w-fit",
                        channelNames.length > 0
                          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                          : "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {channelNames.length > 0 ? "Routed" : "Unrouted"}
                    </Badge>
                  </article>
                );
              })}
          </div>
        </div>
      )}
    </section>
  );
}

function ControlLink({ control }: { control: AutomationLink }) {
  return (
    <Button
      size="sm"
      variant="outline"
      render={<HostLink href={control.href} />}
    >
      {control.label}
    </Button>
  );
}

function ModeBadge({ mode }: { mode: "editable" | "mixed" | "fixed" }) {
  const label =
    mode === "editable"
      ? "Editable"
      : mode === "mixed"
        ? "Editable + fixed safety"
        : "Fixed safety policy";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        mode === "editable" &&
          "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
        mode === "mixed" &&
          "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
        mode === "fixed" &&
          "border-amber-500/30 text-amber-600 dark:text-amber-400",
      )}
    >
      {label}
    </Badge>
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 text-[10px]",
        enabled
          ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground",
      )}
    >
      {enabled ? "Active" : "Draft"}
    </Badge>
  );
}

function EmptyState({ text }: { text: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function AutomationSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
      <Skeleton className="h-[520px] rounded-xl" />
    </div>
  );
}
