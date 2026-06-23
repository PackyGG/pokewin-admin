import { Receipt, ListOrdered } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Receipt}
          accent="rose"
          title="Audit Spend"
          subtitle="Lifetime ledger of every creator cashflow — leaderboard payouts, multiplier deals, expenses, and per-fill conversions as they realize."
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading icon={ListOrdered} title="Filter by event type" />
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-28 rounded-full" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[56px] rounded-2xl" />
    </div>
  );
}
