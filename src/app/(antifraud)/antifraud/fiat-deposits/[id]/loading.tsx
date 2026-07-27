import { ShieldAlert } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function FiatDepositReviewLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity icon={ShieldAlert} accent="cyan" title="Fiat deposit review" subtitle="Loading risk evidence" backHref="/antifraud/fiat-deposits" />
      </PageHero>
      <Skeleton className="h-28 rounded-xl" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-40 rounded-xl" />)}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.7fr)]">
        <Skeleton className="h-[620px] rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
