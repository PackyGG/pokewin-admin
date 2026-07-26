import { Suspense } from "react";
import Link from "next/link";
import {
  BadgeCheck,
  Eye,
  GraduationCap,
  Trophy,
  UserCircle,
  Users,
} from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { sessionRoles } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  canManageStaff,
  canUseStaffProfile,
  requireStaffPage,
} from "@/lib/staff/access";
import { getStaffProfile } from "@/lib/staff/profile";
import { listStaffQuizzes } from "@/lib/staff/quiz";
import { StaffCardsSkeleton } from "./_components/staff-cards-skeleton";

export const metadata = { title: "Staff" };

const QUERY_TIMEOUT_MS = 10_000;

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
        <StaffCards
          adminUserId={session.userId}
          roles={sessionRoles(session)}
          canManage={canManageStaff(session)}
          hasSupportRole={canUseStaffProfile(session)}
        />
      </Suspense>
    </div>
  );
}

async function StaffCards({
  adminUserId,
  roles,
  canManage,
  hasSupportRole,
}: {
  adminUserId: string;
  roles: string[];
  canManage: boolean;
  hasSupportRole: boolean;
}) {
  const [profileResult, quizzesResult] = await Promise.all([
    hasSupportRole
      ? safeQuery(
          () => getStaffProfile(adminUserId),
          null,
          "staff.profile",
          QUERY_TIMEOUT_MS,
        )
      : Promise.resolve({ data: null }),
    canManage || !hasSupportRole
      ? Promise.resolve({ data: [] })
      : safeQuery(
          () => listStaffQuizzes(adminUserId, roles),
          [],
          "staff.quizzes",
          QUERY_TIMEOUT_MS,
        ),
  ]);
  const waiting = quizzesResult.data.filter(
    (quiz) => quiz.canTake && quiz.attemptsUsed === 0,
  ).length;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {hasSupportRole && (
        <StaffLink
          href="/staff/profile"
          icon={UserCircle}
          title="My profile"
          body={`Level ${profileResult.data?.level ?? 1} · ${profileResult.data?.pointsTotal ?? 0} points`}
        />
      )}
      {hasSupportRole && !canManage && (
        <StaffLink
          href="/staff/quizzes"
          icon={GraduationCap}
          title="Quizzes"
          body={`${waiting} waiting to be completed`}
        />
      )}
      {canManage && (
        <>
          <StaffLink
            href="/staff/members"
            icon={Users}
            title="Staff members"
            body="Team leaderboard and manual point awards"
          />
          <StaffLink
            href="/staff/pov"
            icon={Eye}
            title="Support POV"
            body="Preview the staff profile as a support user sees it"
          />
          <StaffLink
            href="/staff/points"
            icon={Trophy}
            title="Point system"
            body="Levels, point history and progression"
          />
          <StaffLink
            href="/staff/quiz-manager"
            icon={BadgeCheck}
            title="Quiz manager"
            body="Create, publish and maintain staff quizzes"
          />
        </>
      )}
    </div>
  );
}

function StaffLink({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-border/60 bg-card p-5 transition-colors hover:border-purple-500/40 hover:bg-accent/30"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-purple-500/15 text-purple-600 dark:text-purple-400">
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </Link>
  );
}
