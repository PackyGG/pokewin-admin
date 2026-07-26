"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, count, eq, inArray, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { staff_quiz_answers, staff_quiz_attempts, staff_quiz_options, staff_quiz_questions, staff_quizzes } from "@/lib/db-schema/admin/schema";
import { sessionRoles } from "@/lib/dal";
import { requireStaffLearner } from "@/lib/staff/access";
import {
  awardStaffPointsInTransaction,
  sendStaffPointNotifications,
  type AwardPointsInput,
} from "@/lib/staff/profile";
import { notifyStaff } from "@/lib/staff/notifications";
import { quizVisibleToRoles, scoreAnswers } from "@/lib/staff/quiz";
import { isPostgresError } from "@/lib/postgres-errors";

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
  const session = await requireStaffLearner();
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { quizId } = parsed.data;

  const [quiz] = await adminDrizzle.select({
    id: staff_quizzes.id, status: staff_quizzes.status,
    max_attempts: staff_quizzes.max_attempts,
    audience_roles: staff_quizzes.audience_roles,
  }).from(staff_quizzes).where(eq(staff_quizzes.id, quizId)).limit(1);
  if (!quiz || quiz.status !== "published") {
    throw new Error("That quiz isn't available");
  }
  if (!quizVisibleToRoles(quiz.audience_roles, sessionRoles(session))) {
    throw new Error("That quiz isn't for your role");
  }

  const [existing] = await adminDrizzle.select({ id: staff_quiz_attempts.id })
    .from(staff_quiz_attempts).where(and(
      eq(staff_quiz_attempts.quiz_id, quizId),
      eq(staff_quiz_attempts.admin_user_id, session.userId),
      eq(staff_quiz_attempts.status, "in_progress"),
    )).limit(1);
  if (existing) return { id: existing.id };

  if (quiz.max_attempts > 0) {
    const [usedRow] = await adminDrizzle.select({ value: count() })
      .from(staff_quiz_attempts).where(and(
        eq(staff_quiz_attempts.quiz_id, quizId),
        eq(staff_quiz_attempts.admin_user_id, session.userId),
        eq(staff_quiz_attempts.status, "submitted"),
      ));
    const used = usedRow?.value ?? 0;
    if (used >= quiz.max_attempts) {
      throw new Error("You've used all your attempts on this quiz");
    }
  }

  const [questionRow] = await adminDrizzle.select({ value: count() })
    .from(staff_quiz_questions).where(eq(staff_quiz_questions.quiz_id, quizId));
  const questionCount = questionRow?.value ?? 0;
  if (questionCount === 0) {
    throw new Error("That quiz has no questions yet");
  }

  try {
    const [created] = await adminDrizzle.insert(staff_quiz_attempts).values({
        quiz_id: quizId,
        admin_user_id: session.userId,
        status: "in_progress",
        question_count: questionCount,
      }).returning({ id: staff_quiz_attempts.id });
    if (!created) throw new Error("Quiz attempt insert returned no row");
    return { id: created.id };
  } catch (err) {
    // Lost the race against another tab — the partial unique index did its
    // job; use the winner.
    if (isPostgresError(err, "23505")) {
      const [winner] = await adminDrizzle.select({ id: staff_quiz_attempts.id })
        .from(staff_quiz_attempts).where(and(
          eq(staff_quiz_attempts.quiz_id, quizId),
          eq(staff_quiz_attempts.admin_user_id, session.userId),
          eq(staff_quiz_attempts.status, "in_progress"),
        )).limit(1);
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
  const session = await requireStaffLearner();
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { attemptId, answers } = parsed.data;

  const [attempt] = await adminDrizzle.select().from(staff_quiz_attempts)
    .where(eq(staff_quiz_attempts.id, attemptId)).limit(1);
  if (!attempt) throw new Error("That attempt no longer exists");
  // Ownership: an attempt id from the client can only ever grade the caller's
  // own attempt.
  if (attempt.admin_user_id !== session.userId) {
    throw new Error("That attempt isn't yours");
  }

  const [quiz] = await adminDrizzle.select({
    id: staff_quizzes.id, title: staff_quizzes.title,
    pass_percent: staff_quizzes.pass_percent,
  }).from(staff_quizzes).where(eq(staff_quizzes.id, attempt.quiz_id)).limit(1);
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
  const questions = await adminDrizzle.select({
    id: staff_quiz_questions.id, points: staff_quiz_questions.points,
  }).from(staff_quiz_questions).where(eq(staff_quiz_questions.quiz_id, attempt.quiz_id))
    .orderBy(staff_quiz_questions.position);
  if (questions.length === 0) throw new Error("That quiz has no questions");

  const options = await adminDrizzle.select({
    id: staff_quiz_options.id, question_id: staff_quiz_options.question_id,
    is_correct: staff_quiz_options.is_correct,
  }).from(staff_quiz_options)
    .where(inArray(staff_quiz_options.question_id, questions.map((q) => q.id)));

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
  const awardInput: AwardPointsInput = {
    adminUserId: session.userId,
    points: scored.score,
    sourceKind: "quiz",
    sourceId: attemptId,
    reason: `${quiz.title} — ${scored.correctCount}/${scored.questionCount} correct`,
    bump: { quizzesCompleted: 1 },
    silent: true,
  };
  const awardResult = await adminDrizzle.transaction(async (tx) => {
    // Guarded update: only an attempt STILL in progress is closed here, so two
    // concurrent submits can't both write a result.
    const updated = await tx.update(staff_quiz_attempts).set({
        status: "submitted",
        score: scored.score,
        max_score: scored.maxScore,
        correct_count: scored.correctCount,
        question_count: scored.questionCount,
        points_awarded: scored.score,
        submitted_at: submittedAt.toISOString(),
      }).where(and(eq(staff_quiz_attempts.id, attemptId),
        eq(staff_quiz_attempts.status, "in_progress")))
      .returning({ id: staff_quiz_attempts.id });
    if (updated.length === 0) return null;

    if (scored.answers.length > 0) {
      await tx.insert(staff_quiz_answers).values(
        scored.answers.map((answer) => ({
          attempt_id: attemptId,
          question_id: answer.questionId,
          selected_option_ids: answer.selectedOptionIds,
          is_correct: answer.isCorrect,
          points_awarded: answer.pointsAwarded,
        })),
      ).onConflictDoUpdate({
          target: [staff_quiz_answers.attempt_id, staff_quiz_answers.question_id],
          set: {
            selected_option_ids: sql`excluded.selected_option_ids`,
            is_correct: sql`excluded.is_correct`,
            points_awarded: sql`excluded.points_awarded`,
          },
      });
    }

    // The immutable event and profile roll-up commit with the attempt.
    // Zero-point attempts get an event too, making completion idempotent.
    return awardStaffPointsInTransaction(tx, awardInput);
  });

  if (!awardResult) {
    const [frozen] = await adminDrizzle.select().from(staff_quiz_attempts)
      .where(eq(staff_quiz_attempts.id, attemptId)).limit(1);
    if (!frozen || frozen.status !== "submitted") {
      throw new Error("Quiz submission did not complete");
    }
    return {
      attemptId: frozen.id,
      score: frozen.score,
      maxScore: frozen.max_score,
      correctCount: frozen.correct_count,
      questionCount: frozen.question_count,
      pointsAwarded: frozen.points_awarded,
      passed:
        frozen.max_score > 0 &&
        (frozen.score / frozen.max_score) * 100 >= quiz.pass_percent,
    };
  }

  const passed =
    scored.maxScore > 0 &&
    (scored.score / scored.maxScore) * 100 >= quiz.pass_percent;

  await sendStaffPointNotifications(awardInput, awardResult);
  await notifyStaff({
    recipients: [session.userId],
    kind: "quiz_result",
    title: `${quiz.title} — ${scored.correctCount}/${scored.questionCount}`,
    body:
      scored.score > 0
        ? `You earned ${scored.score} point${scored.score === 1 ? "" : "s"}.`
        : "No points this time.",
    href: `/staff/quizzes/attempts/${attemptId}`,
    metadata: { quizId: quiz.id, attemptId, score: scored.score, passed },
  });

  revalidatePath("/staff");
  revalidatePath("/staff/profile");
  revalidatePath("/staff/points");

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
