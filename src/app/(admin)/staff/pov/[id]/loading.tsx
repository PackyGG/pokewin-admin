import { Users } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { StaffCardsSkeleton } from "../../_components/staff-cards-skeleton";

export default function SupportPovDetailLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          accent="purple"
          title="Staff"
          subtitle="Profiles, quizzes, points and team progress"
          backHref="/staff/pov"
        />
      </PageHero>
      <Skeleton className="h-12 rounded-xl" />
      <StaffCardsSkeleton />
    </div>
  );
}
