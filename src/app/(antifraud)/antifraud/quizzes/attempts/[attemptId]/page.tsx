import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Trophy, XCircle } from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { canManageAntifraud } from "@/lib/antifraud/access";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { KpiTile } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/utils/format";
import { getAttemptResult } from "@/lib/antifraud/quiz";

export const metadata = { title: "Quiz result" };

/**
 * Antifraud → Quizzes → result.
 *
 * The score screen: how many were right, what it paid, and the full answer key
 * with the taker's own selections marked. The key is only ever revealed HERE,
 * for a SUBMITTED attempt — the take page never receives it.
 *
 * Access: your own attempt, or any attempt if you are an owner/admin (so a
 * manager can review how the team did).
 */
export default async function QuizResultPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const session = await requireAntifraudPageAccess();
  const { attemptId } = await params;

  const result = await getAttemptResult(attemptId);
  if (!result) notFound();

  const isOwnAttempt = result.attempt.adminUserId === session.userId;
  if (!isOwnAttempt && !canManageAntifraud(session)) {
    redirect("/antifraud/quizzes");
  }
  // An attempt that hasn't been submitted has no result to show — send them
  // back to finish it rather than leaking a half-graded view.
  if (result.attempt.status !== "submitted") {
    redirect(`/antifraud/quizzes/${result.attempt.quizId}`);
  }

  const { attempt, quiz, breakdown } = result;
  const percent =
    attempt.maxScore > 0
      ? Math.round((attempt.score / attempt.maxScore) * 100)
      : 0;
  const passed = percent >= quiz.passPercent;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Trophy}
          accent={passed ? "emerald" : "amber"}
          title={quiz.title}
          subtitle="Result"
          backHref="/antifraud/quizzes"
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Correct"
          value={`${attempt.correctCount}/${attempt.questionCount}`}
          sub={`${percent}%`}
          icon={CheckCircle2}
          accent={passed ? "emerald" : "amber"}
        />
        <KpiTile
          label="Points earned"
          value={String(attempt.pointsAwarded)}
          sub={`of ${attempt.maxScore} on offer`}
          icon={Trophy}
          accent="purple"
        />
        <KpiTile
          label="Result"
          value={passed ? "Passed" : "Below pass"}
          sub={`pass mark ${quiz.passPercent}%`}
          icon={passed ? CheckCircle2 : XCircle}
          accent={passed ? "emerald" : "rose"}
        />
        <KpiTile
          label="Submitted"
          value={
            attempt.submittedAt ? formatDateTime(attempt.submittedAt) : "—"
          }
          sub="frozen at this moment"
          icon={Trophy}
          accent="blue"
        />
      </div>

      <ol className="space-y-3">
        {breakdown.map((question, index) => (
          <li
            key={question.questionId}
            className={cn(
              "rounded-xl border bg-card p-4",
              question.isCorrect
                ? "border-emerald-500/30"
                : "border-rose-500/30",
            )}
          >
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-bold",
                  question.isCorrect
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-rose-500/15 text-rose-600 dark:text-rose-400",
                )}
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-relaxed">
                  {question.prompt}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {question.isCorrect
                    ? `Correct · +${question.points} pt${question.points === 1 ? "" : "s"}`
                    : "Incorrect · 0 pts"}
                </p>
              </div>
            </div>

            <ul className="mt-3 space-y-1.5">
              {question.options.map((option) => (
                <li
                  key={option.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    option.isCorrect
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : option.selected
                        ? "border-rose-500/40 bg-rose-500/5"
                        : "border-border/50",
                  )}
                >
                  <span className="min-w-0 flex-1">{option.label}</span>
                  {option.selected && (
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                      your answer
                    </span>
                  )}
                  {option.isCorrect && (
                    <span className="shrink-0 rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      correct
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {question.explanation && (
              <p className="mt-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-relaxed">
                {question.explanation}
              </p>
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/antifraud/quizzes"
          className="rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          Back to quizzes
        </Link>
        <Link
          href="/antifraud/profile"
          className="rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          Your profile
        </Link>
      </div>
    </div>
  );
}
