import { Suspense } from "react";
import { Users } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { sessionRoles } from "@/lib/dal";
import {
  canManageStaff,
  canUseStaffProfile,
  requireStaffPage,
} from "@/lib/staff/access";
import { StaffCardsSkeleton } from "./_components/staff-cards-skeleton";
import { StaffHubCards } from "./_components/staff-hub-cards";

export const metadata = { title: "Staff" };

export default async function StaffPage() {
  const session = await requireStaffPage();

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

      <Suspense fallback={<StaffCardsSkeleton />}>
        <StaffHubCards
          adminUserId={session.userId}
          roles={sessionRoles(session)}
          canManage={canManageStaff(session)}
          hasSupportRole={canUseStaffProfile(session)}
        />
      </Suspense>
    </div>
  );
}
