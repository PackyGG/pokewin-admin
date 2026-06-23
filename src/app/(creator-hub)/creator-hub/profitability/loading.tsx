import { Coins, TrendingUp } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell — matches the page's hero + tab strip + section
 * heading so the swap into the live page doesn't shift layout. Tab strip
 * itself is omitted here (the chips are a client component); a plain bar
 * skeleton stands in to reserve the same horizontal space.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={TrendingUp}
          accent="emerald"
          title="Profitability"
          subtitle="Per-creator deal cost vs expected & actual wager — conversion check."
        />
      </PageHero>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading icon={Coins} title="Deal economics" />
          <Skeleton className="h-9 w-[180px] rounded-lg" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-2xl" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
