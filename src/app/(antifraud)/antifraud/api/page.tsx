import { Braces, RadioTower } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Antifraud API" };

export default async function AntifraudApiPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-8">
      <PageHero>
        <PageHeroIdentity
          icon={Braces}
          accent="blue"
          title="Antifraud API"
          subtitle="HTTP endpoints exposed by the dedicated antifraud service"
          backHref="/antifraud"
        />
      </PageHero>

      <section className="space-y-4">
        <SectionHeading icon={RadioTower} title="HTTP API" />
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          <li className="grid gap-2 px-4 py-3 md:grid-cols-[3.5rem_minmax(12rem,1fr)_minmax(14rem,1.5fr)_10rem] md:items-center">
            <span className="w-fit rounded-md bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-600 dark:text-blue-400">
              GET
            </span>
            <code className="break-all font-mono text-xs font-semibold">
              /v1/top-rain?limit=
            </code>
            <span className="text-xs text-muted-foreground">
              Returns the top completed rain winners from the source ledger.
            </span>
            <span className="text-[11px] text-muted-foreground md:text-right">
              Bearer read token
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
