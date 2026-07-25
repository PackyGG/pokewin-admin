import { Suspense } from "react";
import Link from "next/link";
import { CheckCircle2, GraduationCap, Trophy } from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { canManageAntifraud } from "@/lib/antifraud/access";
import { sessionRoles } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import { listStaffQuizzes } from "@/lib/antifraud/quiz";

export const metadata = { title: "Quizzes" };

/**
 * Antifraud → Quizzes.
 *
 * What a staff member sees: every published quiz their role can take, what it
 * pays, how many attempts they have left, and their best result so far.
 * Authoring lives on the owner/admin-only settings surface.
 *
 * Shell-first: hero paints immediately, the list streams behind Suspense.
 */

const QUERY_TIMEOUT_MS = 10_000;

export default async function QuizzesPage() {
  const session = await requireAntifraudPageAccess();
  const roles = sessionRoles(session);
  const canManage = canManageAntifraud(session);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={GraduationCap}
          accent="purple"
          title="Quizzes"
          subtitle="One point per correct answer"
          action={
            canManage ? (
              <Link
                href="/antifraud/settings/quizzes"
                className="rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
              >
                Manage quizzes
              </Link>
            ) : undefined
          }
        />
      </PageHero>

      <Suspense fallback={<QuizListSkeleton />}>
        <QuizList adminUserId={session.userId} roles={roles} />
      </Suspense>
    </div>
  );
}

async function QuizList({
  adminUserId,
  roles,
}: {
  adminUserId: string;
  roles: string[];
}) {
  const { data: quizzes } = await safeQuery(
    () => listStaffQuizzes(adminUserId, roles),
    [],
    "antifraud.staff-quizzes",
    QUERY_TIMEOUT_MS,
  );

  const open = quizzes.filter((quiz) => quiz.canTake);
  const done = quizzes.filter((quiz) => !quiz.canTake);

  if (quizzes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <GraduationCap className="size-5 text-muted-foreground" />
        <span className="text-sm font-semibold">No quizzes yet</span>
        <span className="max-w-sm text-xs text-muted-foreground">
          When an owner or admin publishes one, it shows up here and you get a
          notification.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {open.length > 0 && (
        <div className="space-y-4">
          <SectionHeading icon={GraduationCap} title="Available to you" />
          <div className="grid gap-3 md:grid-cols-2">
            {open.map((quiz) => (
              <QuizCard key={quiz.id} quiz={quiz} />
            ))}
          </div>
        </div>
      )}

      {done.length > 0 && (
        <div className="space-y-4">
          <SectionHeading icon={CheckCircle2} title="Completed" />
          <div className="grid gap-3 md:grid-cols-2">
            {done.map((quiz) => (
              <QuizCard key={quiz.id} quiz={quiz} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuizCard({
  quiz,
}: {
  quiz: Awaited<ReturnType<typeof listStaffQuizzes>>[number];
}) {
  const scoreLine =
    quiz.bestScore != null && quiz.bestMaxScore
      ? `${quiz.bestScore}/${quiz.bestMaxScore}`
      : null;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{quiz.title}</h3>
          {quiz.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {quiz.description}
            </p>
          )}
        </div>
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            quiz.canTake
              ? "bg-purple-500/10 text-purple-500"
              : "bg-emerald-500/10 text-emerald-500",
          )}
        >
          {quiz.canTake ? (
            <GraduationCap className="size-4" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {quiz.questionCount} question{quiz.questionCount === 1 ? "" : "s"}
        </span>
        <span className="flex items-center gap-1">
          <Trophy className="size-3" />
          {quiz.pointsAvailable} pt{quiz.pointsAvailable === 1 ? "" : "s"}
        </span>
        <span>
          {quiz.attemptsLeft === null
            ? "unlimited attempts"
            : `${quiz.attemptsLeft} attempt${quiz.attemptsLeft === 1 ? "" : "s"} left`}
        </span>
        {quiz.publishedAt && <span>{formatRelative(quiz.publishedAt)}</span>}
      </div>

      {(scoreLine || quiz.pointsEarned > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5 text-[11px]">
          {scoreLine && (
            <span className="font-semibold">Best: {scoreLine}</span>
          )}
          {quiz.pointsEarned > 0 && (
            <span className="text-muted-foreground">
              +{quiz.pointsEarned} point
              {quiz.pointsEarned === 1 ? "" : "s"} earned
            </span>
          )}
          {quiz.openAttemptId && (
            <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              in progress
            </span>
          )}
        </div>
      )}
    </>
  );

  if (!quiz.canTake) {
    return (
      <div className="rounded-xl border border-border/60 bg-card p-4">{body}</div>
    );
  }

  return (
    <Link
      href={`/antifraud/quizzes/${quiz.id}`}
      className="rounded-xl border border-border/60 bg-card p-4 outline-none transition-colors hover:border-purple-500/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </Link>
  );
}

function QuizListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
