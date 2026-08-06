import {
  Activity,
  ArrowRight,
  BellRing,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  Gauge,
  ListChecks,
  Radar,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Siren,
  TimerReset,
  Workflow,
} from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Sign Up & Monitor Guide · Antifraud" };

const riskBands = [
  {
    range: "0-20",
    name: "No risk",
    icon: ShieldCheck,
    accent:
      "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
    monitor: "No monitor",
    notification: "None",
    review: "No",
    locks: "None",
  },
  {
    range: "21-49",
    name: "Low risk",
    icon: Eye,
    accent: "border-cyan-500/30 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400",
    monitor: "5-minute monitor",
    notification: "Action available · No channel",
    review: "No",
    locks: "None",
  },
  {
    range: "50-69",
    name: "High risk",
    icon: ShieldAlert,
    accent:
      "border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400",
    monitor: "10-minute monitor",
    notification: "#high-risk",
    review: "Yes",
    locks: "None",
  },
  {
    range: "70-100",
    name: "Critical risk",
    icon: Siren,
    accent: "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400",
    monitor: "15-minute monitor",
    notification: "#critical-risk",
    review: "Yes",
    locks: "Fiat deposits · Crypto withdrawals · Item withdrawals · Tips",
  },
] as const;

const flow = [
  {
    icon: SearchCheck,
    title: "1. Sign-up check",
    detail:
      "Check the account, identity, network, device, and provider evidence.",
  },
  {
    icon: CheckCircle2,
    title: "2. Score it",
    detail: "Turn the combined evidence into one score from 0 to 100.",
  },
  {
    icon: Clock3,
    title: "3. Monitor higher scores",
    detail: "A score above 20 starts the monitor for that risk band.",
  },
  {
    icon: BellRing,
    title: "4. Apply the entry actions",
    detail:
      "The initial band decides its signup alert, Account Review, and lock actions. Live activity is recorded separately during the timer.",
  },
] as const;

const monitorStages = [
  {
    step: "01",
    icon: Radar,
    title: "Open the window",
    detail:
      "A score of 21+ opens one monitor session from the signup time. The band sets its base length; a risky-location policy can extend it.",
    accent: "border-cyan-500/25 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400",
  },
  {
    step: "02",
    icon: Database,
    title: "Save the baseline",
    detail:
      "Every signup signal is stored as evidence. Initial, current, and peak scores begin from the assessed result.",
    accent: "border-blue-500/25 bg-blue-500/5 text-blue-600 dark:text-blue-400",
  },
  {
    step: "03",
    icon: Activity,
    title: "Collect fresh activity",
    detail:
      "New account events are read in order, deduplicated, and written to the same monitor trail with their configured points.",
    accent:
      "border-violet-500/25 bg-violet-500/5 text-violet-600 dark:text-violet-400",
  },
  {
    step: "04",
    icon: Workflow,
    title: "Evaluate behavior flows",
    detail:
      "After activity commits, enabled sequence rules can add points and run their own configured review or alert action.",
    accent:
      "border-orange-500/25 bg-orange-500/5 text-orange-600 dark:text-orange-400",
  },
  {
    step: "05",
    icon: CheckCircle2,
    title: "Close on the latest score",
    detail:
      "At the fixed deadline, the session completes and the latest score and severity become the monitor case result.",
    accent:
      "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
  },
] as const;

const liveScoreFacts = [
  {
    icon: Gauge,
    label: "Bounded score",
    value: "0-100",
    detail:
      "Every accepted event adds or subtracts its configured point value.",
  },
  {
    icon: ShieldCheck,
    label: "Trust floor",
    value: "Initial -30",
    detail:
      "Positive activity can reduce risk, but never more than 30 points below the starting score.",
  },
  {
    icon: ListChecks,
    label: "Durable trail",
    value: "One row per event",
    detail:
      "The evidence, point change, and score after the event remain attached to the session.",
  },
  {
    icon: TimerReset,
    label: "Fixed deadline",
    value: "No restart",
    detail:
      "New activity changes the score but does not restart or extend the signup monitor.",
  },
] as const;

const reviewHandlingSteps = [
  {
    step: "01",
    icon: Eye,
    title: "Open and take ownership",
    detail:
      "Clicking Review starts the case and automatically assigns it to your admin account.",
  },
  {
    step: "02",
    icon: CheckCircle2,
    title: "Take action or postpone",
    detail:
      "Complete a review action, or use the Postpone button when you need more time.",
  },
  {
    step: "03",
    icon: TimerReset,
    title: "Closing also postpones",
    detail:
      "If no action was completed, clicking the X or outside the review postpones it and schedules a Discord reminder in 2 hours.",
  },
] as const;

const monitoredBands = [
  {
    range: "21-49",
    name: "Low risk",
    duration: "5 minutes",
    action: "Monitor + optional low-risk Discord route",
    note: "No Account Review or automatic locks.",
    accent: "border-cyan-500/25 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400",
  },
  {
    range: "50-69",
    name: "High risk",
    duration: "10 minutes",
    action: "High-risk alert + Account Review",
    note: "No score-based automatic locks.",
    accent:
      "border-orange-500/25 bg-orange-500/5 text-orange-600 dark:text-orange-400",
  },
  {
    range: "70-100",
    name: "Critical risk",
    duration: "15 minutes",
    action: "Priority alert + Account Review + containment",
    note: "Fiat deposits, withdrawals, items, and tips are locked.",
    accent: "border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400",
  },
] as const;

export default async function AntifraudSignupGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <section className="grid gap-4 xl:grid-cols-4">
        {riskBands.map((band) => {
          const Icon = band.icon;
          return (
            <article
              key={band.range}
              className={`rounded-xl border p-4 ${band.accent}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-80">
                    {band.range} points
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-foreground">
                    {band.name}
                  </h2>
                </div>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/80">
                  <Icon className="size-4" />
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Monitoring</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.monitor}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Discord</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.notification}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Review</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.review}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Locks</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.locks}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-xl border border-orange-500/20 bg-card">
        <div className="border-b border-border/60 bg-orange-500/[0.04] p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:text-orange-400">
              <ShieldAlert className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold">
                How staff handles signup reviews
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                High and Critical signups enter Account Review. Opening one
                means taking responsibility for its next action.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          <div className="grid gap-3 md:grid-cols-3">
            {reviewHandlingSteps.map((step, index) => {
              const Icon = step.icon;
              return (
                <article
                  key={step.step}
                  className="relative rounded-lg border border-border/60 bg-muted/20 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-orange-600 dark:text-orange-400">
                      Step {step.step}
                    </span>
                    <span className="flex size-8 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:text-orange-400">
                      <Icon className="size-4" />
                    </span>
                  </div>
                  <h3 className="mt-4 text-sm font-semibold">{step.title}</h3>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {step.detail}
                  </p>
                  {index < reviewHandlingSteps.length - 1 && (
                    <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-muted-foreground/50 md:block" />
                  )}
                </article>
              );
            })}
          </div>

        </div>
      </section>

      <section className="rounded-xl border border-border/70 bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <SearchCheck className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">
              How a signup moves through Fraud
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              The initial assessment is permanent evidence. Monitoring then
              watches fresh activity and can add new evidence to the same case.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {flow.map((step) => {
            const Icon = step.icon;
            return (
              <div
                key={step.title}
                className="rounded-lg border border-border/60 bg-muted/20 p-3"
              >
                <Icon className="size-4 text-cyan-600 dark:text-cyan-400" />
                <p className="mt-3 text-xs font-semibold">{step.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {step.detail}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-cyan-500/20 bg-card">
        <div className="border-b border-border/60 bg-cyan-500/[0.04] p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                <Radar className="size-5" />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">Monitor flow</h2>
                  <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-600 dark:text-cyan-400">
                    Starts at 21 points
                  </span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center text-[10px] font-semibold tabular-nums">
              <span className="rounded-md border border-cyan-500/20 bg-cyan-500/5 px-2 py-1.5 text-cyan-600 dark:text-cyan-400">
                5 min
              </span>
              <span className="rounded-md border border-orange-500/20 bg-orange-500/5 px-2 py-1.5 text-orange-600 dark:text-orange-400">
                10 min
              </span>
              <span className="rounded-md border border-rose-500/20 bg-rose-500/5 px-2 py-1.5 text-rose-600 dark:text-rose-400">
                15 min
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-5 p-5 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {monitorStages.map((stage, index) => {
              const Icon = stage.icon;
              return (
                <article
                  key={stage.step}
                  className={`relative rounded-lg border p-3.5 ${stage.accent}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-70">
                      Step {stage.step}
                    </span>
                    <span className="flex size-7 items-center justify-center rounded-md bg-background/80">
                      <Icon className="size-3.5" />
                    </span>
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-foreground">
                    {stage.title}
                  </h3>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {stage.detail}
                  </p>
                  {index < monitorStages.length - 1 && (
                    <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-muted-foreground/50 xl:block" />
                  )}
                </article>
              );
            })}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Gauge className="size-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold">
                    How the live score works
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    The same point weights shown in Rules &amp; Scoring are
                    applied to accepted activity during the window.
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2.5 font-mono text-[11px] font-medium">
                <span className="text-muted-foreground">current score</span>
                <span>+</span>
                <span className="text-violet-600 dark:text-violet-400">
                  event points
                </span>
                <ArrowRight className="size-3.5 text-muted-foreground" />
                <span className="text-cyan-600 dark:text-cyan-400">
                  clamp(initial - 30, result, 100)
                </span>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {liveScoreFacts.map((fact) => {
                  const Icon = fact.icon;
                  return (
                    <div
                      key={fact.label}
                      className="rounded-lg border border-border/50 bg-background/70 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-xs font-semibold">
                          <Icon className="size-3.5 text-cyan-600 dark:text-cyan-400" />
                          {fact.label}
                        </span>
                        <span className="text-[11px] font-semibold tabular-nums text-foreground">
                          {fact.value}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
                        {fact.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/15 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Clock3 className="size-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold">
                    What the entry band starts
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    These actions are decided once, from the completed signup
                    assessment.
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {monitoredBands.map((band) => (
                  <div
                    key={band.range}
                    className={`rounded-lg border p-3 ${band.accent}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-background/80 px-2 py-1 text-[10px] font-bold tabular-nums">
                          {band.range}
                        </span>
                        <span className="text-xs font-semibold text-foreground">
                          {band.name}
                        </span>
                      </div>
                      <span className="text-[11px] font-semibold tabular-nums">
                        {band.duration}
                      </span>
                    </div>
                    <p className="mt-2 text-xs font-medium text-foreground">
                      {band.action}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      {band.note}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </section>
    </div>
  );
}
