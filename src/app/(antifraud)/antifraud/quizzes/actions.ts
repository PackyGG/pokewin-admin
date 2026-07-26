"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { sessionRoles } from "@/lib/dal";
import { requireAntifraudStaff } from "@/lib/require-antifraud-access";
import { awardStaffPoints } from "@/lib/antifraud/profile";
import { notifyStaff } from "@/lib/antifraud/notifications";
import { quizVisibleToRoles, scoreAnswers } from "@/lib/antifraud/quiz";

/**
 * Taking a quiz.
 *
 * The two rules that make the points mean something, both enforced HERE on the
 * server rather than in the form:
 *
 *  1. THE ANSWER KEY NEVER REACHES THE CLIENT WHILE AN ATTEMPT IS OPEN. The
 *     take page reads options WITHOUT `is_correct`; scoring loads the key
 *     server-side at submit time. There is no client-side grading to tamper
 *     with.
 *
 *  2. ONE PAYOUT PER ATTEMPT. Points go through `awardStaffPoints` keyed on
 *     ('quiz', attemptId), and the partial unique index on
 *     `staff_point_events (source_kind, source_id)` makes a retried or
 *     double-clicked submit idempotent at the database level, not just in
 *     application logic.
 */

const startSchema = z.object({ quizId: z.string().uuid("Invalid quiz") });

/**
 * Start (or resume) an attempt. Resuming is the default: the partial unique
 * index allows exactly one open attempt per (staff, quiz), so a reload or a
 * second tab lands back on the same attempt rather than burning a try.
 */
export async function startQuizAttempt(input: unknown): Promise<{ id: string }> {
  const session = await requireAntifraudStaff();
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { quizId } = parsed.data;

  const quiz = await adminDb.staff_quizzes.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      status: true,
      max_attempts: true,
      audience_roles: true,
    },
  });
  if (!quiz || quiz.status !== "published") {
    throw new Error("That quiz isn't available");
  }
  if (!quizVisibleToRoles(quiz.audience_roles, sessionRoles(session))) {
    throw new Error("That quiz isn't for your role");
  }

  const existing = await adminDb.staff_quiz_attempts.findFirst({
    where: {
      quiz_id: quizId,
      admin_user_id: session.userId,
      status: "in_progress",
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id };

  if (quiz.max_attempts > 0) {
    const used = await adminDb.staff_quiz_attempts.count({
      where: {
        quiz_id: quizId,
        admin_user_id: session.userId,
        status: "submitted",
      },
    });
    if (used >= quiz.max_attempts) {
      throw new Error("You've used all your attempts on this quiz");
    }
  }

  const questionCount = await adminDb.staff_quiz_questions.count({
    where: { quiz_id: quizId },
  });
  if (questionCount === 0) {
    throw new Error("That quiz has no questions yet");
  }

  try {
    const created = await adminDb.staff_quiz_attempts.create({
      data: {
        quiz_id: quizId,
        admin_user_id: session.userId,
        status: "in_progress",
        question_count: questionCount,
      },
      select: { id: true },
    });
    return { id: created.id };
  } catch (err) {
    // Lost the race against another tab — the partial unique index did its
    // job; use the winner.
    if ((err as { code?: string })?.code === "P2002") {
      const winner = await adminDb.staff_quiz_attempts.findFirst({
        where: {
          quiz_id: quizId,
          admin_user_id: session.userId,
          status: "in_progress",
        },
        select: { id: true },
      });
      if (winner) return { id: winner.id };
    }
    throw err;
  }
}

const submitSchema = z.object({
  attemptId: z.string().uuid("Invalid attempt"),
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid(),
        optionIds: z.array(z.string().uuid()).max(20),
      }),
    )
    .max(200),
});

export type SubmitResult = {
  attemptId: string;
  score: number;
  maxScore: number;
  correctCount: number;
  questionCount: number;
  pointsAwarded: number;
  passed: boolean;
};

/** Grade and close an attempt, then pay the points out. */
export async function submitQuizAttempt(
  input: unknown,
): Promise<SubmitResult> {
  const session = await requireAntifraudStaff();
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { attemptId, answers } = parsed.data;

  const attempt = await adminDb.staff_quiz_attempts.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      quiz_id: true,
      admin_user_id: true,
      status: true,
      score: true,
      max_score: true,
      correct_count: true,
      question_count: true,
      points_awarded: true,
    },
  });
  if (!attempt) throw new Error("That attempt no longer exists");
  // Ownership: an attempt id from the client can only ever grade the caller's
  // own attempt.
  if (attempt.admin_user_id !== session.userId) {
    throw new Error("That attempt isn't yours");
  }

  const quiz = await adminDb.staff_quizzes.findUnique({
    where: { id: attempt.quiz_id },
    select: { id: true, title: true, pass_percent: true },
  });
  if (!quiz) throw new Error("That quiz no longer exists");

  // Already submitted (double-click, back button) — report the frozen result
  // rather than re-grading it.
  if (attempt.status === "submitted") {
    return {
      attemptId: attempt.id,
      score: attempt.score,
      maxScore: attempt.max_score,
      correctCount: attempt.correct_count,
      questionCount: attempt.question_count,
      pointsAwarded: attempt.points_awarded,
      passed:
        attempt.max_score > 0 &&
        (attempt.score / attempt.max_score) * 100 >= quiz.pass_percent,
    };
  }

  // ── Load the answer key (server-side only) ───────────────────────────
  const questions = await adminDb.staff_quiz_questions.findMany({
    where: { quiz_id: attempt.quiz_id },
    orderBy: { position: "asc" },
    select: { id: true, points: true },
  });
  if (questions.length === 0) throw new Error("That quiz has no questions");

  const options = await adminDb.staff_quiz_options.findMany({
    where: { question_id: { in: questions.map((q) => q.id) } },
    select: { id: true, question_id: true, is_correct: true },
  });

  const correctByQuestion = new Map<string, string[]>();
  const validByQuestion = new Map<string, Set<string>>();
  for (const option of options) {
    if (option.is_correct) {
      const list = correctByQuestion.get(option.question_id) ?? [];
      list.push(option.id);
      correctByQuestion.set(option.question_id, list);
    }
    const valid = validByQuestion.get(option.question_id) ?? new Set<string>();
    valid.add(option.id);
    validByQuestion.set(option.question_id, valid);
  }

  // Drop any option id that doesn't actually belong to its question — a
  // hand-crafted payload can't smuggle in another question's correct option.
  const submitted = new Map<string, string[]>(
    answers.map((answer) => [
      answer.questionId,
      answer.optionIds.filter((id) =>
        validByQuestion.get(answer.questionId)?.has(id),
      ),
    ]),
  );

  const scored = scoreAnswers(
    questions.map((q) => ({
      id: q.id,
      points: q.points,
      correctOptionIds: correctByQuestion.get(q.id) ?? [],
    })),
    submitted,
  );

  // ── Freeze the result ────────────────────────────────────────────────
  const submittedAt = new Date();
  await adminDb.$transaction(async (tx) => {
    // Guarded update: only an attempt STILL in progress is closed here, so two
    // concurrent submits can't both write a result.
    const updated = await tx.staff_quiz_attempts.updateMany({
      where: { id: attemptId, status: "in_progress" },
      data: {
        status: "submitted",
        score: scored.score,
        max_score: scored.maxScore,
        correct_count: scored.correctCount,
        question_count: scored.questionCount,
        points_awarded: scored.score,
        submitted_at: submittedAt,
      },
    });
    if (updated.count === 0) return; // another submit won the race

    for (const answer of scored.answers) {
      await tx.staff_quiz_answers.upsert({
        where: {
          attempt_id_question_id: {
            attempt_id: attemptId,
            question_id: answer.questionId,
          },
        },
        update: {
          selected_option_ids: answer.selectedOptionIds,
          is_correct: answer.isCorrect,
          points_awarded: answer.pointsAwarded,
        },
        create: {
          attempt_id: attemptId,
          question_id: answer.questionId,
          selected_option_ids: answer.selectedOptionIds,
          is_correct: answer.isCorrect,
          points_awarded: answer.pointsAwarded,
        },
      });
    }
  });

  // ── Pay out ──────────────────────────────────────────────────────────
  // Keyed on the attempt id: the unique index makes this idempotent, so a
  // retry after a network blip cannot pay twice.
  if (scored.score > 0) {
    await awardStaffPoints({
      adminUserId: session.userId,
      points: scored.score,
      sourceKind: "quiz",
      sourceId: attemptId,
      reason: `${quiz.title} — ${scored.correctCount}/${scored.questionCount} correct`,
      bump: { quizzesCompleted: 1 },
      // The quiz-result notification below is the one the taker should see.
      silent: true,
    });
  } else {
    // No points, but the attempt still counts as completed.
    await adminDb.staff_profiles
      .update({
        where: { admin_user_id: session.userId },
        data: { quizzes_completed: { increment: 1 } },
      })
      .catch(() => {});
  }

  const passed =
    scored.maxScore > 0 &&
    (scored.score / scored.maxScore) * 100 >= quiz.pass_percent;

  await notifyStaff({
    recipients: [session.userId],
    kind: "quiz_result",
    title: `${quiz.title} — ${scored.correctCount}/${scored.questionCount}`,
    body:
      scored.score > 0
        ? `You earned ${scored.score} point${scored.score === 1 ? "" : "s"}.`
        : "No points this time.",
    href: `/antifraud/quizzes/attempts/${attemptId}`,
    metadata: { quizId: quiz.id, attemptId, score: scored.score, passed },
  });

  revalidatePath("/antifraud/quizzes");
  revalidatePath("/antifraud/profile");
  revalidatePath("/antifraud/staff");
  revalidatePath("/antifraud");

  return {
    attemptId,
    score: scored.score,
    maxScore: scored.maxScore,
    correctCount: scored.correctCount,
    questionCount: scored.questionCount,
    pointsAwarded: scored.score,
    passed,
  };
}
