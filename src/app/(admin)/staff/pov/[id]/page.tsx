import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Eye, Users } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireStaffManagerPage } from "@/lib/staff/access";
import { loadAdminIdentities } from "@/lib/staff/identities";
import { StaffCardsSkeleton } from "../../_components/staff-cards-skeleton";
import { StaffHubCards } from "../../_components/staff-hub-cards";

export const metadata = { title: "Support Staff Hub POV" };

export default async function SupportPovDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStaffManagerPage();
  const { id } = await params;
  const identity = (await loadAdminIdentities([id])).get(id);
  if (!identity?.roles.includes("support")) notFound();

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

      <div className="flex items-center gap-2 rounded-xl border border-purple-500/20 bg-purple-500/[0.06] px-4 py-3 text-sm text-purple-700 dark:text-purple-300">
        <Eye className="size-4 shrink-0" />
        Previewing the Staff Hub as {identity.label}. Cards are read-only in
        preview mode.
      </div>

      <Suspense fallback={<StaffCardsSkeleton />}>
        <StaffHubCards
          adminUserId={id}
          roles={identity.roles}
          canManage={false}
          hasSupportRole
          preview
        />
      </Suspense>
    </div>
  );
}
