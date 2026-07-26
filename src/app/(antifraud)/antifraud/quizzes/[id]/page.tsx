import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { GraduationCap } from "lucide-react";

import { requireAntifraudStaffPage } from "@/lib/require-antifraud-access";
import { sessionRoles } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getQuizForTake, quizVisibleToRoles } from "@/lib/antifraud/quiz";
import { QuizRunner } from "../_components/quiz-runner";

export const metadata = { title: "Take quiz" };

/**
 * Antifraud → Quizzes → take one.
 *
 * The page loads the quiz WITHOUT its answer key (`getQuizForTake` never
 * selects `is_correct`) and hands it to the client runner. Starting, grading
 * and paying out all happen in the server actions — this page performs no
 * mutation of its own, so a reload or a prefetch can never burn an attempt.
 *
 * A staff member who has already used all their attempts is bounced to the
 * quiz list instead of being shown a quiz they can't take.
 *
 * Shell-first: the back affordance paints immediately, the quiz streams in.
 */
export default async function TakeQuizPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAntifraudStaffPage();
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={GraduationCap}
          accent="purple"
          title="Quiz"
          subtitle="Quiz"
          backHref="/antifraud/quizzes"
        />
      </PageHero>

      <Suspense key={id} fallback={<QuizIntroSkeleton />}>
        <QuizStage
          quizId={id}
          adminUserId={session.userId}
          roles={sessionRoles(session)}
        />
      </Suspense>
    </div>
  );
}

async function QuizStage({
  quizId,
  adminUserId,
  roles,
}: {
  quizId: string;
  adminUserId: string;
  roles: string[];
}) {
  // Resume an open attempt if there is one — it also seeds the (optional)
  // deterministic question shuffle so a reload doesn't reorder mid-attempt.
  const openAttempt = await adminDb.staff_quiz_attempts
    .findFirst({
      where: {
        quiz_id: quizId,
        admin_user_id: adminUserId,
        status: "in_progress",
      },
      select: { id: true },
    })
    .catch(() => null);

  const loaded = await getQuizForTake(quizId, openAttempt?.id);
  if (!loaded) notFound();

  const { quiz, questions } = loaded;

  if (!quizVisibleToRoles(quiz.audienceRoles, roles)) {
    redirect("/antifraud/quizzes");
  }

  // Attempts already spent — only meaningful when there is no open attempt to
  // resume (resuming never costs an extra try).
  const submittedCount = await adminDb.staff_quiz_attempts
    .count({
      where: {
        quiz_id: quizId,
        admin_user_id: adminUserId,
        status: "submitted",
      },
    })
    .catch(() => 0);

  const attemptsLeft =
    quiz.maxAttempts > 0 ? Math.max(0, quiz.maxAttempts - submittedCount) : null;

  if (!openAttempt && attemptsLeft !== null && attemptsLeft <= 0) {
    redirect("/antifraud/quizzes");
  }

  const pointsAvailable = questions.reduce((sum, q) => sum + q.points, 0);

  return (
    <QuizRunner
      quizId={quiz.id}
      title={quiz.title}
      description={quiz.description}
      questions={questions}
      pointsAvailable={pointsAvailable}
      attemptsLeft={attemptsLeft}
      timeLimitSeconds={quiz.timeLimitSeconds}
      resumeAttemptId={openAttempt?.id ?? null}
      shuffleQuestions={quiz.shuffleQuestions}
    />
  );
}

function QuizIntroSkeleton() {
  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
      <div className="flex items-start gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-9 w-32 rounded-md" />
    </div>
  );
}
