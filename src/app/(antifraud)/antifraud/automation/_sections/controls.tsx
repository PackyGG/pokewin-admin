import {
  Activity,
  BellRing,
  Gauge,
  ListChecks,
  Settings2,
  Workflow,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";

/** Index of the pages that own each authoritative control. */
export function AutomationControls() {
  return <ConfigurationIndex />;
}

const CONTROLS = [
  {
    title: "Global Fiat controls",
    text: "Enable or disable Fiat deposits site-wide and choose automatic credit or admin approval after verification.",
    href: "/antifraud/config",
    label: "Edit Fiat controls",
    icon: Settings2,
  },
  {
    title: "Risk scoring",
    text: "Point weights for signup, provider, activity, network, and creator signals, plus the severity bands they map into.",
    href: "/antifraud/points",
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
    title: "Network & creator checks",
    text: "Connected-component scoring and referred-account fraud checks.",
    href: "/antifraud/points?tab=network",
    label: "Edit checks",
    icon: ListChecks,
  },
  {
    title: "Discord routing",
    text: "Assign every alert action to one channel and choose which staff groups it tags.",
    href: "/antifraud/discord",
    label: "Edit routes",
    icon: BellRing,
  },
  {
    title: "Detection inputs",
    text: "Browse the canonical live and planned event vocabulary used by point flows.",
    href: "/antifraud/events",
    label: "Browse events",
    icon: Activity,
  },
  {
    title: "Integrations & health",
    text: "Providers, live transport, signed ingest, Fiat eligibility, and the ingestion loop.",
    href: "/antifraud/settings",
    label: "Inspect integrations",
    icon: Settings2,
  },
] as const;

function ConfigurationIndex() {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Settings2}
        title={
          <>
            Everything you can configure
            <span className="text-xs font-normal text-muted-foreground">
              each control links to the page that owns it
            </span>
          </>
        }
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {CONTROLS.map((control) => {
          const Icon = control.icon;
          return (
            <div
              key={control.title}
              className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card p-4"
            >
              <div className="flex items-center gap-2">
                <Icon
                  className="size-4 text-cyan-600 dark:text-cyan-400"
                  aria-hidden
                />
                <h3 className="text-sm font-semibold">{control.title}</h3>
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
