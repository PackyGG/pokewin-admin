import { Suspense } from "react";
import {
  CheckCircle2,
  ListChecks,
  Lock,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getAntifraudScoringConfig } from "@/lib/antifraud/monitor-api";
import { getFiatDepositAutomaticCreditConfig } from "@/lib/backend-api/fiat-deposit-review";
import { GlobalFiatReviewCard } from "../../config/fiat-auto-approval-card";
import { AUTOMATION_FLOWS, type AutomationFlow } from "../_lib/automation-catalog";
import { EmptyState, ModeBadge, StatusBadge } from "./shared";

/**
 * AUTOMATION TAB — everything that can fire, split by who owns it, plus the one
 * automation switch this workspace owns outright.
 *
 * Operator-editable point flows come first (they are the part staff actually
 * change), then the code-owned catalog grouped by how much of it is editable,
 * so "can I change this without a release?" is answerable at a glance instead
 * of by reading each card's badge.
 *
 * The global Fiat auto-credit switch used to sit on its own near-empty
 * `/antifraud/config` page. It is an automation control, so it lives here; that
 * route now redirects to this tab.
 */
export async function AutomationSection() {
  const scoring = await getAntifraudScoringConfig();
  const rules = scoring.data?.behaviorRules ?? [];
  const available = scoring.configured && !scoring.error && scoring.data !== null;

  const groups: Array<{
    mode: AutomationFlow["mode"];
    title: string;
    description: string;
  }> = [
    {
      mode: "editable",
      title: "Fully operator-controlled",
      description: "changeable from this workspace, no release needed",
    },
    {
      mode: "mixed",
      title: "Operator-tuned with fixed safety",
      description: "weights and lists are editable; the safety behavior is not",
    },
    {
      mode: "fixed",
      title: "Fixed safety policy",
      description: "code-owned; changing it needs a release",
    },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading icon={ShieldCheck} title="Global Fiat review" />
        <Suspense fallback={<Skeleton className="h-52 w-full rounded-xl" />}>
          <GlobalFiatReviewData />
        </Suspense>
      </section>

      <PointFlows rules={rules} available={available} />

      {groups.map((group) => {
        const flows = AUTOMATION_FLOWS.filter(
          (flow) => flow.mode === group.mode,
        );
        if (flows.length === 0) return null;
        return (
          <section key={group.mode} className="space-y-3">
            <SectionHeading
              icon={group.mode === "fixed" ? Lock : ListChecks}
              title={
                <>
                  {group.title}
                  <span className="text-xs font-normal text-muted-foreground">
                    {group.description}
                  </span>
                </>
              }
            />
            <div className="space-y-3">
              {flows.map((flow) => (
                <FlowCard key={flow.name} flow={flow} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

async function GlobalFiatReviewData() {
  try {
    const config = await getFiatDepositAutomaticCreditConfig();
    return (
      <GlobalFiatReviewCard
        initialEnabled={config.fiat_deposit_automatic_credit_enabled}
      />
    );
  } catch (error) {
    console.error("[antifraud-settings] Fiat approval config read failed:", error);
    return <GlobalFiatReviewCard initialEnabled={null} />;
  }
}

function PointFlows({
  rules,
  available,
}: {
  rules: NonNullable<
    Awaited<ReturnType<typeof getAntifraudScoringConfig>>["data"]
  >["behaviorRules"];
  available: boolean;
}) {
  const active = rules.filter((rule) => rule.enabled).length;
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Workflow}
        title={
          <>
            Point flows
            <span className="text-xs font-normal text-muted-foreground">
              {available
                ? `${active} of ${rules.length} evaluated live`
                : "live configuration unavailable"}
            </span>
          </>
        }
        action={
          <Button
            size="sm"
            variant="outline"
            render={<HostLink href="/antifraud/settings?tab=flows" />}
          >
            Open flow builder
          </Button>
        }
      />
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        {!available ? (
          <EmptyState text="The live point-flow configuration is unavailable." />
        ) : rules.length === 0 ? (
          <EmptyState text="No point flows are configured yet." />
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
                    Window:{" "}
                    <strong className="text-foreground">
                      {rule.window_seconds}s
                    </strong>
                  </p>
                  <p className="mt-1">
                    Outcome:{" "}
                    <strong className="text-foreground">
                      {rule.score_delta > 0 ? "+" : ""}
                      {rule.score_delta} points + manual review
                    </strong>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-fit lg:justify-self-end"
                  render={<HostLink href="/antifraud/settings?tab=flows" />}
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

function FlowCard({ flow }: { flow: AutomationFlow }) {
  const Icon = flow.icon;
  return (
    <article className="rounded-xl border border-border/60 bg-card p-4">
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
            <Button
              key={`${flow.name}-${control.href}`}
              size="sm"
              variant="outline"
              render={<HostLink href={control.href} />}
            >
              {control.label}
            </Button>
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
                <CheckCircle2
                  className="mt-1 size-3 shrink-0 text-cyan-600 dark:text-cyan-400"
                  aria-hidden
                />
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
}
