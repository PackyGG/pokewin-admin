import {
  Ban,
  CheckCircle2,
  Gauge,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Siren,
  TrendingDown,
} from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = {
  title: "Fiat Pre-Payment Check Guide · Antifraud",
};

const basicChecks = [
  "Account banned",
  "Account locked",
  "Account self-excluded",
  "Fiat deposits disabled for the user",
  "Fiat deposits blocked for the country",
  "Required KYC not approved",
] as const;

const securityChecks = [
  "Request or Fingerprint event is invalid",
  "Fingerprint belongs to another user",
  "Fingerprint or ProxyCheck is unavailable",
] as const;

const fraudChecks = [
  "VPN, proxy, Tor, or attack signals",
  "Changed or shared IP/device since signup or latest login",
  "Suspected alt or existing Fraud case",
  "Repeated checkout attempts or previous denials",
  "Suspicious funding, rewards, or withdrawal history",
] as const;

const trustSignals = [
  "Older account",
  "Completed crypto deposits",
  "Previous completed Fiat deposits",
  "Normal paid gameplay and wagering",
] as const;

const gateSections = [
  {
    icon: Ban,
    title: "Basic account checks",
    subtitle: "No score involved — any failure denies checkout immediately.",
    accent: "border-rose-500/25 bg-rose-500/5 text-rose-600 dark:text-rose-400",
    items: basicChecks,
  },
  {
    icon: ShieldX,
    title: "Request security checks",
    subtitle: "Confirms the checkout request is genuine.",
    accent:
      "border-orange-500/25 bg-orange-500/5 text-orange-600 dark:text-orange-400",
    items: securityChecks,
  },
  {
    icon: Gauge,
    title: "Fraud checks",
    subtitle: "Builds the 0-100 risk score.",
    accent: "border-cyan-500/25 bg-cyan-500/5 text-cyan-600 dark:text-cyan-400",
    items: fraudChecks,
  },
] as const;

const outcomes = [
  {
    range: "0-49",
    name: "Allow",
    icon: ShieldCheck,
    accent:
      "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
    detail: "Checkout is allowed. The allow is valid for 60 seconds.",
  },
  {
    range: "50-100",
    name: "Deny",
    icon: ShieldAlert,
    accent:
      "border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400",
    detail: "Checkout is denied on score alone.",
  },
  {
    range: "Any",
    name: "Hard blocker",
    icon: Ban,
    accent: "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400",
    detail: "Deny regardless of score — basic or security check failed.",
  },
  {
    range: "Any",
    name: "Containment",
    icon: Siren,
    accent:
      "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-400",
    detail:
      "Deny, open Account Review, disable Fiat deposits, and lock crypto and item withdrawals.",
  },
] as const;

export default async function AntifraudFiatPrePaymentGuidePage() {
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
          Fiat pre-payment check
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          A one-time checkout gate that decides whether a user should be
          allowed to open a Fiat checkout right now. It does not monitor the
          user afterward — that is a separate post-payment stage.
        </p>
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        {gateSections.map((section) => {
          const Icon = section.icon;
          return (
            <article
              key={section.title}
              className={`rounded-xl border p-4 ${section.accent}`}
            >
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/80">
                  <Icon className="size-4" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    {section.title}
                  </h2>
                  <p className="mt-0.5 text-xs leading-5 opacity-80">
                    {section.subtitle}
                  </p>
                </div>
              </div>

              <ul className="mt-4 space-y-2">
                {section.items.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-xs leading-5 text-foreground"
                  >
                    <span className="mt-1 size-1 shrink-0 rounded-full bg-current opacity-60" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </section>

      <section className="rounded-xl border border-border/70 bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <TrendingDown className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Good-account evidence</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Established accounts can earn up to 30 points of trust credit,
              reducing the score below what the raw signals would otherwise
              produce.
            </p>
          </div>
        </div>

        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {trustSignals.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs leading-5 text-foreground"
            >
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className="overflow-hidden rounded-xl border border-cyan-500/20 bg-card">
        <div className="border-b border-border/60 bg-cyan-500/[0.04] p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
              <ListChecks className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold">Result</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                The check does not automatically ban the user or require KYC —
                it only decides this one checkout attempt.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-4">
          {outcomes.map((outcome) => {
            const Icon = outcome.icon;
            return (
              <article
                key={outcome.name}
                className={`rounded-lg border p-3.5 ${outcome.accent}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-70">
                    {outcome.range}
                  </span>
                  <span className="flex size-7 items-center justify-center rounded-md bg-background/80">
                    <Icon className="size-3.5" />
                  </span>
                </div>
                <h3 className="mt-3 text-sm font-semibold text-foreground">
                  {outcome.name}
                </h3>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {outcome.detail}
                </p>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
