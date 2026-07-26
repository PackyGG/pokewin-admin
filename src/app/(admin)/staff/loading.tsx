import { Users } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { StaffCardsSkeleton } from "./_components/staff-cards-skeleton";

export default function StaffLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          accent="purple"
          title="Staff"
          subtitle="Profiles, quizzes, points and team progress"
        />
      </PageHero>
      <StaffCardsSkeleton />
    </div>
  );
}
