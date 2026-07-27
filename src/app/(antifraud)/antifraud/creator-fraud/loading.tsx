import { ShieldAlert } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function CreatorFraudLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Creator fraud"
          subtitle="Fraud risk among referred accounts; the creator account's own behavior is excluded"
        />
      </PageHero>
      <Skeleton className="h-10 rounded-md" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
