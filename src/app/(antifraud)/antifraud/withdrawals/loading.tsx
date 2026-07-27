import { ArrowUpFromLine } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function WithdrawalsLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpFromLine}
          accent="cyan"
          title="Withdrawals"
          subtitle="Trace every payout back to its deposits, play, wins, and rewards"
        />
      </PageHero>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-12 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
