import { Suspense } from "react";
import Link from "next/link";
import { BadgeCheck, GraduationCap } from "lucide-react";

import { requireStaffManagerPage } from "@/lib/staff/access";
import { safeQuery } from "@/lib/errors/safe-query";
import { adminDb } from "@/lib/admin-db";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/utils/format";
import { listAllQuizzes } from "@/lib/staff/quiz";
import { QuizStatusBadge } from "../_components/badges";
import { QuizFormDialog } from "./_components/quiz-form-dialog";

export const metadata = { title: "Quiz Manager" };

/**
 * Antifraud → Manage → Quiz Manager. OWNER / ADMIN ONLY.
 *
 * The authoring index: every quiz in every state, with how many questions it
 * has and how many people have taken it. Publishing happens on the editor page
 * (one click, and it notifies the audience).
 */

const QUERY_TIMEOUT_MS = 10_000;

export default async function QuizManagerPage() {
  await requireStaffManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={BadgeCheck}
          accent="purple"
          title="Quiz Manager"
          subtitle="Write quizzes, publish them, watch the team take them"
          action={<QuizFormDialog />}
          backHref="/staff"
        />
      </PageHero>

      <Suspense fallback={<ListSkeleton />}>
        <QuizTable />
      </Suspense>
    </div>
  );
}

async function QuizTable() {
  const { data: quizzes } = await safeQuery(
    () => listAllQuizzes(),
    [],
    "antifraud.quiz-manager",
    QUERY_TIMEOUT_MS,
  );

  // One grouped count for the whole page rather than a per-row query.
  const attemptCounts = await adminDb.staff_quiz_attempts
    .groupBy({
      by: ["quiz_id"],
      where: { status: "submitted" },
      _count: { _all: true },
    })
    .catch(() => [] as { quiz_id: string; _count: { _all: number } }[]);
  const takenByQuiz = new Map(
    attemptCounts.map((row) => [row.quiz_id, row._count._all]),
  );

  if (quizzes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <GraduationCap className="size-5 text-muted-foreground" />
        <span className="text-sm font-semibold">No quizzes yet</span>
        <span className="max-w-sm text-xs text-muted-foreground">
          Create a draft, add questions, then publish it — everyone in the
          audience gets a notification when you do.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={BadgeCheck}
        title={
          <>
            All quizzes
            <span className="text-xs font-normal text-muted-foreground">
              ({quizzes.length})
            </span>
          </>
        }
      />
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {quizzes.map((quiz) => (
          <li key={quiz.id}>
            <Link
              href={`/staff/quiz-manager/${quiz.id}`}
              className="flex flex-col gap-2 px-3 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">
                    {quiz.title}
                  </span>
                  <QuizStatusBadge status={quiz.status} />
                </span>
                {quiz.description && (
                  <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                    {quiz.description}
                  </span>
                )}
                {quiz.audienceRoles.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {quiz.audienceRoles.map((role) => (
                      <span
                        key={role}
                        className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {role.replace("_", " ")}
                      </span>
                    ))}
                  </span>
                )}
              </span>

              <span className="flex shrink-0 flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span>
                  {quiz.questionCount} question
                  {quiz.questionCount === 1 ? "" : "s"}
                </span>
                <span>{takenByQuiz.get(quiz.id) ?? 0} taken</span>
                <span className="whitespace-nowrap">
                  {formatRelative(quiz.updatedAt)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border/60">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
