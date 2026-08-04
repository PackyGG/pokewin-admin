import {
  BellRing,
  CheckCircle2,
  Clock3,
  Eye,
  LockKeyhole,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Siren,
} from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Sign-up Checks Guide · Antifraud" };

const riskBands = [
  {
    range: "0-20",
    name: "No risk",
    icon: ShieldCheck,
    accent: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
    monitor: "No monitor",
    notification: "No Discord notification",
    review: "No Account Review",
    action: "The assessment is saved. Nothing else happens.",
  },
  {
    range: "21-49",
    name: "Low risk",
    icon: Eye,
    accent: "border-cyan-500/30 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400",
    monitor: "5-minute monitor",
    notification: "Low-risk signup action",
    review: "No Account Review",
    action: "Staff are informed. No restriction is applied.",
  },
  {
    range: "50-69",
    name: "High risk",
    icon: ShieldAlert,
    accent: "border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400",
    monitor: "10-minute monitor",
    notification: "High-risk signup action",
    review: "Account Review opens",
    action: "Staff review the evidence. No automatic restriction is applied.",
  },
  {
    range: "70-100",
    name: "Critical risk",
    icon: Siren,
    accent: "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400",
    monitor: "15-minute monitor",
    notification: "Critical-risk signup action",
    review: "Account Review opens",
    action: "Fiat deposits, withdrawals, and tips are locked automatically.",
  },
] as const;

const flow = [
  {
    icon: SearchCheck,
    title: "1. Check",
    detail: "Internal account evidence and configured providers are checked.",
  },
  {
    icon: CheckCircle2,
    title: "2. Score",
    detail: "Evidence becomes a bounded score from 0 to 100.",
  },
  {
    icon: Clock3,
    title: "3. Monitor",
    detail: "Scores above 20 watch new activity for their band duration.",
  },
  {
    icon: BellRing,
    title: "4. Act",
    detail: "The matching Discord, review, and lock actions run automatically.",
  },
] as const;

export default async function AntifraudSignupGuidePage() {
  await requireAntifraudPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-600 dark:text-cyan-400">
          Guide
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Sign-up checks
        </h1>
      </div>

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
              </dl>

              <p className="mt-4 border-t border-current/15 pt-3 text-xs leading-5 text-foreground">
                {band.action}
              </p>
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

      <section className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400">
            <LockKeyhole className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Critical containment</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              A score of 70 or more immediately disables Fiat deposits, locks
              crypto and item withdrawals, and locks tips. It does not
              automatically ban the account or request KYC. Staff make the
              final decision from Account Review.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
