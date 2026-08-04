import {
  BellRing,
  CheckCircle2,
  Clock3,
  Eye,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Siren,
} from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Sign Up & Monitor Guide · Antifraud" };

const riskBands = [
  {
    range: "0-20",
    name: "No risk",
    icon: ShieldCheck,
    accent: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
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
    accent: "border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400",
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
    detail: "Check the account, identity, network, device, and provider evidence.",
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
    title: "4. Decide",
    detail:
      "The latest score decides the outcome when monitoring ends, or immediately if new points cross a higher threshold.",
  },
] as const;

const monitorFlow = [
  {
    icon: Clock3,
    title: "1. Start the timer",
    detail: "Low risk runs for 5 minutes, High for 10, and Critical for 15.",
  },
  {
    icon: Eye,
    title: "2. Watch new activity",
    detail: "Fresh account activity and evidence are added while the timer is active.",
  },
  {
    icon: ShieldAlert,
    title: "3. Move up immediately",
    detail:
      "If new evidence raises the score into High or Critical, its Discord, Review, and lock actions happen immediately.",
  },
  {
    icon: CheckCircle2,
    title: "4. Finish on the latest score",
    detail: "When monitoring ends, the latest score decides the final risk result.",
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

              <dl className="mt-4 space-y-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Monitoring</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.monitor}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Discord</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.notification}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Review</dt>
                  <dd className="mt-0.5 font-semibold text-foreground">
                    {band.review}
                  </dd>
                </div>
                <div>
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

      <section className="rounded-xl border border-border/70 bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <SearchCheck className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">How a signup moves through Fraud</h2>
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
              <div key={step.title} className="rounded-lg border border-border/60 bg-muted/20 p-3">
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

      <section className="rounded-xl border border-border/70 bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Clock3 className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Monitor flow</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Monitoring starts only for scores above 20. Low-risk alerts have
              an available Discord action, but it is not routed to a channel.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {monitorFlow.map((step) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="rounded-lg border border-border/60 bg-muted/20 p-3">
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

    </div>
  );
}
