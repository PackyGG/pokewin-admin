import { Coins, TrendingUp } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

import { ProfitabilitySkeleton } from "./_components/profitability-skeleton";

/**
 * Route-level loading shell — tab-agnostic on purpose (it reads nothing):
 * renders the SectionHeading identity + section heading row both tabs share,
 * then the ONE shared `ProfitabilitySkeleton` (the same module the in-page
 * Suspense fallback uses), so the swap into the live page doesn't shift
 * layout. The tab strip is a client component; a plain bar skeleton stands
 * in to reserve the same horizontal space.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <SectionHeading icon={TrendingUp} title="Profitability" />
        <Skeleton className="h-4 w-72 rounded" />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading icon={Coins} title="Deal economics" />
          <Skeleton className="h-9 w-[180px] rounded-lg" />
        </div>
        <ProfitabilitySkeleton />
      </div>
    </div>
  );
}
