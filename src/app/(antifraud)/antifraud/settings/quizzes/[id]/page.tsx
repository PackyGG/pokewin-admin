import { Suspense } from "react";
import { notFound } from "next/navigation";
import { BadgeCheck, ListChecks, Users } from "lucide-react";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { adminDb } from "@/lib/admin-db";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/utils/format";
import { getQuizForEdit } from "@/lib/antifraud/quiz";
import { loadAdminIdentities } from "@/lib/antifraud/identities";
import { QuizStatusBadge } from "../../../_components/badges";
import { QuizFormDialog } from "../_components/quiz-form-dialog";
import { QuizStatusActions } from "../_components/quiz-status-actions";
import { QuestionWorkbench } from "./_components/question-workbench";

export const metadata = { title: "Edit quiz" };

/**
 * Antifraud → Manage → Quiz Manager → one quiz. OWNER / ADMIN ONLY.
 *
 * Settings at the top (edit dialog + publish/archive/delete), questions below.
 * Publishing is blocked server-side until every question has a correct answer
 * marked — finding that mistake after 30 people have taken the quiz is far
 * worse than a blocked click.
 *
 * Re-authoring a published quiz is allowed: every submitted attempt froze its
 * own score and answer rows, so past results can never be rewritten.
 */
export default async function QuizEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAntifraudManagerPage();
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={BadgeCheck}
          accent="purple"
          title="Quiz"
          subtitle="Quiz"
          backHref="/antifraud/settings/quizzes"
        />
      </PageHero>

      <Suspense key={id} fallback={<EditorSkeleton />}>
        <QuizEditor quizId={id} />
      </Suspense>
    </div>
  );
}

async function QuizEditor({ quizId: id }: { quizId: string }) {
  const loaded = await getQuizForEdit(id);
  if (!loaded) notFound();
  const { quiz, questions } = loaded;

  const [attempts, takers] = await Promise.all([
    adminDb.staff_quiz_attempts
      .findMany({
        where: { quiz_id: id, status: "submitted" },
        orderBy: { submitted_at: "desc" },
        take: 25,
      })
      .catch(() => []),
    adminDb.staff_quiz_attempts
      .count({ where: { quiz_id: id, status: "submitted" } })
      .catch(() => 0),
  ]);

  const identities = await loadAdminIdentities(
    attempts.map((a) => a.admin_user_id),
  );

  const pointsAvailable = questions.reduce((sum, q) => sum + q.points, 0);
  const averageScore =
    attempts.length > 0
      ? Math.round(
          (attempts.reduce(
            (sum, a) => sum + (a.max_score > 0 ? a.score / a.max_score : 0),
            0,
          ) /
            attempts.length) *
            100,
        )
      : null;

  return (
    <div className="space-y-6">
      {/* ── Title + status + actions ─────────────────────────────────
          The edit dialog lives here rather than in the page hero: the hero
          streams nothing (it paints before this data exists), and settings
          belong next to publish/archive anyway. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card p-4">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-base font-semibold tracking-tight">
            {quiz.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <QuizStatusBadge status={quiz.status} />
            <span className="text-xs text-muted-foreground">
              {quiz.publishedAt
                ? `published ${formatRelative(quiz.publishedAt)}`
                : "never published"}
            </span>
          </div>
          {quiz.description && (
            <p className="text-xs text-muted-foreground">{quiz.description}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <QuizFormDialog
            mode="edit"
            initial={{
              quizId: quiz.id,
              title: quiz.title,
              description: quiz.description ?? "",
              passPercent: quiz.passPercent,
              maxAttempts: quiz.maxAttempts,
              timeLimitMinutes: quiz.timeLimitSeconds
                ? Math.round(quiz.timeLimitSeconds / 60)
                : 0,
              shuffleQuestions: quiz.shuffleQuestions,
              audienceRoles: quiz.audienceRoles,
            }}
          />
          <QuizStatusActions
            quizId={quiz.id}
            status={quiz.status}
            hasAttempts={takers > 0}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Questions"
          value={String(questions.length)}
          sub={`${pointsAvailable} pt${pointsAvailable === 1 ? "" : "s"} on offer`}
          icon={ListChecks}
          accent="purple"
        />
        <KpiTile
          label="Taken by"
          value={String(takers)}
          sub="submitted attempts"
          icon={Users}
          accent="cyan"
        />
        <KpiTile
          label="Average score"
          value={averageScore === null ? "—" : `${averageScore}%`}
          sub={`pass mark ${quiz.passPercent}%`}
          icon={BadgeCheck}
          accent="emerald"
        />
        <KpiTile
          label="Attempts allowed"
          value={quiz.maxAttempts === 0 ? "Unlimited" : String(quiz.maxAttempts)}
          sub={
            quiz.timeLimitSeconds
              ? `${Math.round(quiz.timeLimitSeconds / 60)} min limit`
              : "untimed"
          }
          icon={ListChecks}
          accent="amber"
        />
      </div>

      {/* ── Questions ──────────────────────────────────────────────── */}
      <div className="space-y-4">
        <SectionHeading icon={ListChecks} title="Questions" />
        <QuestionWorkbench
          quizId={quiz.id}
          questions={questions.map((question) => ({
            id: question.id,
            prompt: question.prompt,
            kind: question.kind,
            points: question.points,
            explanation: question.explanation,
            options: question.options.map((option) => ({
              id: option.id,
              label: option.label,
              isCorrect: option.isCorrect,
            })),
          }))}
        />
      </div>

      {/* ── Results ────────────────────────────────────────────────── */}
      {attempts.length > 0 && (
        <div className="space-y-4">
          <SectionHeading icon={Users} title="Recent results" />
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {attempts.map((attempt) => (
              <li
                key={attempt.id}
                className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {identities.get(attempt.admin_user_id)?.label ??
                    attempt.admin_user_id.slice(0, 8)}
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums">
                  {attempt.correct_count}/{attempt.question_count}
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                  +{attempt.points_awarded} pt
                  {attempt.points_awarded === 1 ? "" : "s"}
                </span>
                <span className="w-20 shrink-0 text-right text-[11px] text-muted-foreground">
                  {attempt.submitted_at
                    ? formatRelative(attempt.submitted_at)
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-28" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
