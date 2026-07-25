import { notFound, redirect } from "next/navigation";
import { GraduationCap } from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { sessionRoles } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
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
 */
export default async function TakeQuizPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAntifraudPageAccess();
  const { id } = await params;

  // Resume an open attempt if there is one — it also seeds the (optional)
  // deterministic question shuffle so a reload doesn't reorder mid-attempt.
  const openAttempt = await adminDb.staff_quiz_attempts
    .findFirst({
      where: {
        quiz_id: id,
        admin_user_id: session.userId,
        status: "in_progress",
      },
      select: { id: true },
    })
    .catch(() => null);

  const loaded = await getQuizForTake(id, openAttempt?.id);
  if (!loaded) notFound();

  const { quiz, questions } = loaded;

  if (!quizVisibleToRoles(quiz.audienceRoles, sessionRoles(session))) {
    redirect("/antifraud/quizzes");
  }

  // Attempts already spent — only meaningful when there is no open attempt to
  // resume (resuming never costs an extra try).
  const submittedCount = await adminDb.staff_quiz_attempts
    .count({
      where: {
        quiz_id: id,
        admin_user_id: session.userId,
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
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={GraduationCap}
          accent="purple"
          title={quiz.title}
          subtitle="Quiz"
          backHref="/antifraud/quizzes"
        />
      </PageHero>

      <QuizRunner
        quizId={quiz.id}
        title={quiz.title}
        description={quiz.description}
        questions={questions}
        pointsAvailable={pointsAvailable}
        attemptsLeft={attemptsLeft}
        timeLimitSeconds={quiz.timeLimitSeconds}
        resumeAttemptId={openAttempt?.id ?? null}
      />
    </div>
  );
}
