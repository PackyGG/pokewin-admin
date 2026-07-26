import Link from "next/link";
import {
  BadgeCheck,
  Eye,
  GraduationCap,
  Trophy,
  UserCircle,
  Users,
} from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import { getStaffProfile } from "@/lib/staff/profile";
import { listStaffQuizzes } from "@/lib/staff/quiz";

const QUERY_TIMEOUT_MS = 10_000;

export async function StaffHubCards({
  adminUserId,
  roles,
  canManage,
  hasSupportRole,
  preview = false,
}: {
  adminUserId: string;
  roles: string[];
  canManage: boolean;
  hasSupportRole: boolean;
  preview?: boolean;
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
          preview={preview}
        />
      )}
      {hasSupportRole && !canManage && (
        <StaffLink
          href="/staff/quizzes"
          icon={GraduationCap}
          title="Quizzes"
          body={`${waiting} waiting to be completed`}
          preview={preview}
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
            body="Preview the Staff Hub as a support agent sees it"
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
  preview = false,
}: {
  href: string;
  icon: React.ElementType;
  title: string;
  body: string;
  preview?: boolean;
}) {
  const content = (
    <>
      <span className="flex size-10 items-center justify-center rounded-xl bg-purple-500/15 text-purple-600 dark:text-purple-400">
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </>
  );

  if (preview) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-5">
        {content}
      </div>
    );
  }

  return (
    <Link
      href={href}
      className="group rounded-2xl border border-border/60 bg-card p-5 transition-colors hover:border-purple-500/40 hover:bg-accent/30"
    >
      {content}
    </Link>
  );
}
