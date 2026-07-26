import {
  BellRing,
  Check,
  ExternalLink,
  ShieldCheck,
  Siren,
  Users,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";

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
            <span className="size-1.5 rounded-full bg-emerald-500" />
            <code className="font-mono text-xs">{id}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DiscordConfigSection() {
  return (
    <section className="space-y-5">
      <div>
        <SectionHeading icon={BellRing} title="Discord alerts" />
        <p className="mt-2 text-xs text-muted-foreground">
          The webhook secret stays in Railway. This page shows the safe,
          operator-facing delivery configuration only.
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
              <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Configured
              </span>
            </div>

            <div className="mt-5 rounded-lg border border-border/60 bg-muted/20 p-4">
              <p className="text-sm font-semibold">Rule matched: Example rule</p>
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
            {[
              ["Standard accent", "Discord blurple · #5865F2"],
              ["Urgent accent", "Red · #EF4444"],
              ["Button destination", "fraud.packydash.com/monitor"],
              ["Automatic trigger", "Matched antifraud rules"],
              ["Urgent trigger", "Not defined yet"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-border/50 pb-3 last:border-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RecipientList
          title="Always tag support"
          description="These accounts are mentioned on every antifraud rule alert."
          ids={SUPPORT_IDS}
        />
        <RecipientList
          title="Urgent escalation"
          description="These accounts are added only when a future trigger is explicitly marked urgent."
          ids={URGENT_IDS}
          urgent
        />
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
          <Check className="size-3.5" />
        </span>
        <div>
          <p className="text-sm font-semibold">Mention safety enabled</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Discord is allowed to mention only the IDs listed above. Alert text
            cannot create extra user, role, here, or everyone pings.
          </p>
        </div>
      </div>
    </section>
  );
}
