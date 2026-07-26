import "server-only";

import { and, count, desc, eq, inArray } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  staff_quiz_answers, staff_quiz_attempts, staff_quiz_options,
  staff_quiz_questions, staff_quizzes,
} from "@/lib/db-schema/admin/schema";
import { isMissingRelationError } from "./notifications";
import { isQuestionKind, stableShuffle, type QuestionKind } from "./constants";

/**
 * The staff quiz system.
 *
 * Owners/admins author quizzes in the Staff hub; every staff member takes them
 * and earns ONE POINT PER CORRECT ANSWER (or the
 * per-question override). Three question shapes cover what was asked for:
 *
 *   yes_no  — a two-button Yes / No question
 *   single  — several options, exactly one correct (radio)
 *   multi   — several options, any number correct (checkbox)
 *
 * `multi` is scored ALL-OR-NOTHING: the selected set must equal the correct set
 * exactly. Partial credit would make "tick everything" a winning strategy.
 *
 * SECURITY: `is_correct` never leaves the server while an attempt is open. The
 * take-quiz read below selects only (id, label, position); the answer key is
 * loaded server-side at submit time and again for the result screen, which the
 * staff member only reaches after submitting.
 */

// The question-shape vocabulary lives in the isomorphic `./constants` module so
// the authoring Client Components can import it WITHOUT dragging this
// server-only file — and therefore database code — into the browser bundle.
// Re-exported here so every existing server-side import keeps working.
export {
  QUESTION_KINDS,
  QUESTION_KIND_LABELS,
  QUIZ_STATUSES,
  isQuestionKind,
  isQuizStatus,
  type QuestionKind,
  type QuizStatus,
} from "./constants";

// ─── Shapes ───────────────────────────────────────────────────────────────

export type QuizSummary = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  pointsPerCorrect: number;
  passPercent: number;
  maxAttempts: number;
  timeLimitSeconds: number | null;
  shuffleQuestions: boolean;
  audienceRoles: string[];
  questionCount: number;
  createdBy: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A quiz as a staff member sees it in their list, with their own state. */
export type StaffQuizCard = QuizSummary & {
  /** Points on offer = sum of question points. */
  pointsAvailable: number;
  attemptsUsed: number;
  attemptsLeft: number | null;
  /** An attempt they can resume, if any. */
  openAttemptId: string | null;
  /** Their best submitted attempt, if any. */
  bestScore: number | null;
  bestMaxScore: number | null;
  lastSubmittedAt: Date | null;
  pointsEarned: number;
  canTake: boolean;
};

export type TakeOption = { id: string; label: string };
export type TakeQuestion = {
  id: string;
  prompt: string;
  kind: QuestionKind;
  points: number;
  options: TakeOption[];
};
export type QuizForTake = {
  quiz: QuizSummary;
  questions: TakeQuestion[];
};

export type EditOption = TakeOption & { isCorrect: boolean; position: number };
export type EditQuestion = {
  id: string;
  prompt: string;
  kind: QuestionKind;
  points: number;
  explanation: string | null;
  position: number;
  options: EditOption[];
};
export type QuizForEdit = {
  quiz: QuizSummary;
  questions: EditQuestion[];
};

type QuizRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  points_per_correct: number;
  pass_percent: number;
  max_attempts: number;
  time_limit_seconds: number | null;
  shuffle_questions: boolean;
  audience_roles: string[];
  created_by: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toSummary(row: QuizRow, questionCount: number): QuizSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    pointsPerCorrect: row.points_per_correct,
    passPercent: row.pass_percent,
    maxAttempts: row.max_attempts,
    timeLimitSeconds: row.time_limit_seconds,
    shuffleQuestions: row.shuffle_questions,
    audienceRoles: [...row.audience_roles],
    questionCount,
    createdBy: row.created_by,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ─── Author-side reads (settings) ─────────────────────────────────────────

/** Every quiz, newest first — the settings list. */
export async function listAllQuizzes(): Promise<QuizSummary[]> {
  try {
    const rows = await adminDrizzle.select().from(staff_quizzes)
      .orderBy(desc(staff_quizzes.created_at)).limit(200);
    if (rows.length === 0) return [];
    const counts = await adminDrizzle.select({
      quiz_id: staff_quiz_questions.quiz_id, value: count(),
    }).from(staff_quiz_questions)
      .where(inArray(staff_quiz_questions.quiz_id, rows.map((r) => r.id)))
      .groupBy(staff_quiz_questions.quiz_id);
    const countByQuiz = new Map(counts.map((c) => [c.quiz_id, c.value]));
    return rows.map((row) => toSummary(row, countByQuiz.get(row.id) ?? 0));
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listAllQuizzes failed:", err);
    }
    return [];
  }
}

/** The full quiz WITH the answer key — settings/editor only. */
export async function getQuizForEdit(
  quizId: string,
): Promise<QuizForEdit | null> {
  try {
    const [quiz] = await adminDrizzle.select().from(staff_quizzes)
      .where(eq(staff_quizzes.id, quizId)).limit(1);
    if (!quiz) return null;

    const questions = await adminDrizzle.select().from(staff_quiz_questions)
      .where(eq(staff_quiz_questions.quiz_id, quizId))
      .orderBy(staff_quiz_questions.position);
    const options =
      questions.length === 0
        ? []
        : await adminDrizzle.select().from(staff_quiz_options)
            .where(inArray(staff_quiz_options.question_id, questions.map((q) => q.id)))
            .orderBy(staff_quiz_options.position);

    const byQuestion = new Map<string, EditOption[]>();
    for (const opt of options) {
      const list = byQuestion.get(opt.question_id) ?? [];
      list.push({
        id: opt.id,
        label: opt.label,
        isCorrect: opt.is_correct,
        position: opt.position,
      });
      byQuestion.set(opt.question_id, list);
    }

    return {
      quiz: toSummary(quiz, questions.length),
      questions: questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        kind: isQuestionKind(q.kind) ? q.kind : "single",
        points: q.points,
        explanation: q.explanation,
        position: q.position,
        options: byQuestion.get(q.id) ?? [],
      })),
    };
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] getQuizForEdit failed:", err);
    }
    return null;
  }
}

// ─── Staff-side reads (taking) ────────────────────────────────────────────

/** True if a quiz's audience covers a viewer holding `roles`. */
export function quizVisibleToRoles(
  audienceRoles: readonly string[],
  roles: readonly string[],
): boolean {
  if (audienceRoles.length === 0) return true;
  return roles.some((r) => audienceRoles.includes(r));
}

/**
 * The staff member's quiz list: every PUBLISHED quiz whose audience includes
 * them, joined with their own attempt history.
 */
export async function listStaffQuizzes(
  adminUserId: string,
  roles: readonly string[],
): Promise<StaffQuizCard[]> {
  try {
    const rows = await adminDrizzle.select().from(staff_quizzes)
      .where(eq(staff_quizzes.status, "published"))
      .orderBy(desc(staff_quizzes.published_at)).limit(100);
    const visible = rows.filter((row) =>
      quizVisibleToRoles(row.audience_roles, roles),
    );
    if (visible.length === 0) return [];

    const quizIds = visible.map((r) => r.id);
    const [questions, attempts] = await Promise.all([
      adminDrizzle.select({
        quiz_id: staff_quiz_questions.quiz_id, points: staff_quiz_questions.points,
      }).from(staff_quiz_questions).where(inArray(staff_quiz_questions.quiz_id, quizIds)),
      adminDrizzle.select().from(staff_quiz_attempts).where(and(
        inArray(staff_quiz_attempts.quiz_id, quizIds),
        eq(staff_quiz_attempts.admin_user_id, adminUserId),
      )).orderBy(desc(staff_quiz_attempts.started_at)),
    ]);

    const statsByQuiz = new Map<string, { count: number; points: number }>();
    for (const q of questions) {
      const prev = statsByQuiz.get(q.quiz_id) ?? { count: 0, points: 0 };
      statsByQuiz.set(q.quiz_id, {
        count: prev.count + 1,
        points: prev.points + q.points,
      });
    }

    return visible.map((row) => {
      const stats = statsByQuiz.get(row.id) ?? { count: 0, points: 0 };
      const mine = attempts.filter((a) => a.quiz_id === row.id);
      const submitted = mine.filter((a) => a.status === "submitted");
      const open = mine.find((a) => a.status === "in_progress") ?? null;

      const attemptsUsed = submitted.length;
      const attemptsLeft =
        row.max_attempts > 0
          ? Math.max(0, row.max_attempts - attemptsUsed)
          : null;

      const best = submitted.reduce<(typeof submitted)[number] | null>(
        (acc, a) => (acc === null || a.score > acc.score ? a : acc),
        null,
      );

      return {
        ...toSummary(row, stats.count),
        pointsAvailable: stats.points,
        attemptsUsed,
        attemptsLeft,
        openAttemptId: open?.id ?? null,
        bestScore: best?.score ?? null,
        bestMaxScore: best?.max_score ?? null,
        lastSubmittedAt: submitted[0]?.submitted_at ? new Date(submitted[0].submitted_at) : null,
        pointsEarned: submitted.reduce((sum, a) => sum + a.points_awarded, 0),
        canTake:
          stats.count > 0 &&
          (open !== null || attemptsLeft === null || attemptsLeft > 0),
      } satisfies StaffQuizCard;
    });
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] listStaffQuizzes failed:", err);
    }
    return [];
  }
}

/**
 * The quiz as the taker sees it — WITHOUT the answer key.
 *
 * `shuffle_questions` is applied here with a per-attempt deterministic order so
 * a reload doesn't reshuffle mid-attempt (the seed is the attempt id).
 */
export async function getQuizForTake(
  quizId: string,
  seed?: string,
): Promise<QuizForTake | null> {
  try {
    const [quiz] = await adminDrizzle.select().from(staff_quizzes)
      .where(eq(staff_quizzes.id, quizId)).limit(1);
    if (!quiz || quiz.status !== "published") return null;

    const questions = await adminDrizzle.select({
      id: staff_quiz_questions.id, prompt: staff_quiz_questions.prompt,
      kind: staff_quiz_questions.kind, points: staff_quiz_questions.points,
    }).from(staff_quiz_questions).where(eq(staff_quiz_questions.quiz_id, quizId))
      .orderBy(staff_quiz_questions.position);
    if (questions.length === 0) return null;

    const options = await adminDrizzle.select({
      // NOTE: `is_correct` is deliberately NOT selected.
      id: staff_quiz_options.id, label: staff_quiz_options.label,
      question_id: staff_quiz_options.question_id,
    }).from(staff_quiz_options)
      .where(inArray(staff_quiz_options.question_id, questions.map((q) => q.id)))
      .orderBy(staff_quiz_options.position);

    const byQuestion = new Map<string, TakeOption[]>();
    for (const opt of options) {
      const list = byQuestion.get(opt.question_id) ?? [];
      list.push({ id: opt.id, label: opt.label });
      byQuestion.set(opt.question_id, list);
    }

    const ordered =
      quiz.shuffle_questions && seed
        ? stableShuffle(questions, seed)
        : questions;

    return {
      quiz: toSummary(quiz, questions.length),
      questions: ordered.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        kind: isQuestionKind(q.kind) ? q.kind : "single",
        points: q.points,
        options: byQuestion.get(q.id) ?? [],
      })),
    };
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] getQuizForTake failed:", err);
    }
    return null;
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────

export type ScoredAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  correctOptionIds: string[];
  isCorrect: boolean;
  pointsAwarded: number;
};

export type ScoredAttempt = {
  answers: ScoredAnswer[];
  score: number;
  maxScore: number;
  correctCount: number;
  questionCount: number;
};

/**
 * Pure scoring over an answer key. Exported so it can be reasoned about (and
 * tested) independently of the DB round-trip in the submit action.
 *
 * Every question kind is scored the same way — set equality between the
 * selected options and the correct ones. For `yes_no` and `single` that is
 * "picked the right one"; for `multi` it is all-or-nothing, deliberately:
 * partial credit would make selecting everything a winning strategy.
 */
export function scoreAnswers(
  questions: readonly {
    id: string;
    points: number;
    correctOptionIds: readonly string[];
  }[],
  submitted: ReadonlyMap<string, readonly string[]>,
): ScoredAttempt {
  const answers: ScoredAnswer[] = [];
  let score = 0;
  let maxScore = 0;
  let correctCount = 0;

  for (const question of questions) {
    maxScore += question.points;
    const selected = [...new Set(submitted.get(question.id) ?? [])];
    const correct = [...new Set(question.correctOptionIds)];

    const isCorrect =
      correct.length > 0 &&
      selected.length === correct.length &&
      selected.every((id) => correct.includes(id));

    const pointsAwarded = isCorrect ? question.points : 0;
    if (isCorrect) {
      score += pointsAwarded;
      correctCount += 1;
    }

    answers.push({
      questionId: question.id,
      selectedOptionIds: selected,
      correctOptionIds: correct,
      isCorrect,
      pointsAwarded,
    });
  }

  return {
    answers,
    score,
    maxScore,
    correctCount,
    questionCount: questions.length,
  };
}

// ─── Attempt reads ────────────────────────────────────────────────────────

export type AttemptResult = {
  attempt: {
    id: string;
    quizId: string;
    adminUserId: string;
    status: string;
    score: number;
    maxScore: number;
    correctCount: number;
    questionCount: number;
    pointsAwarded: number;
    startedAt: Date;
    submittedAt: Date | null;
  };
  quiz: QuizSummary;
  /** Per-question breakdown with the answer key revealed (post-submit only). */
  breakdown: {
    questionId: string;
    prompt: string;
    kind: QuestionKind;
    explanation: string | null;
    points: number;
    isCorrect: boolean;
    options: { id: string; label: string; isCorrect: boolean; selected: boolean }[];
  }[];
};

/**
 * A submitted attempt with its full breakdown. Callers MUST check
 * `attempt.adminUserId` against the viewer (or that the viewer is an owner /
 * admin) — this read does not gate by itself.
 */
export async function getAttemptResult(
  attemptId: string,
): Promise<AttemptResult | null> {
  try {
    const [attempt] = await adminDrizzle.select().from(staff_quiz_attempts)
      .where(eq(staff_quiz_attempts.id, attemptId)).limit(1);
    if (!attempt) return null;

    const [quiz] = await adminDrizzle.select().from(staff_quizzes)
      .where(eq(staff_quizzes.id, attempt.quiz_id)).limit(1);
    if (!quiz) return null;

    const [questions, answers] = await Promise.all([
      adminDrizzle.select().from(staff_quiz_questions)
        .where(eq(staff_quiz_questions.quiz_id, attempt.quiz_id))
        .orderBy(staff_quiz_questions.position),
      adminDrizzle.select().from(staff_quiz_answers)
        .where(eq(staff_quiz_answers.attempt_id, attemptId)),
    ]);

    const options =
      questions.length === 0
        ? []
        : await adminDrizzle.select().from(staff_quiz_options)
            .where(inArray(staff_quiz_options.question_id, questions.map((q) => q.id)))
            .orderBy(staff_quiz_options.position);

    const answerByQuestion = new Map(answers.map((a) => [a.question_id, a]));

    return {
      attempt: {
        id: attempt.id,
        quizId: attempt.quiz_id,
        adminUserId: attempt.admin_user_id,
        status: attempt.status,
        score: attempt.score,
        maxScore: attempt.max_score,
        correctCount: attempt.correct_count,
        questionCount: attempt.question_count,
        pointsAwarded: attempt.points_awarded,
        startedAt: new Date(attempt.started_at),
        submittedAt: attempt.submitted_at ? new Date(attempt.submitted_at) : null,
      },
      quiz: toSummary(quiz, questions.length),
      breakdown: questions.map((q) => {
        const answer = answerByQuestion.get(q.id);
        const selected = new Set(answer?.selected_option_ids ?? []);
        return {
          questionId: q.id,
          prompt: q.prompt,
          kind: isQuestionKind(q.kind) ? q.kind : "single",
          explanation: q.explanation,
          points: q.points,
          isCorrect: answer?.is_correct ?? false,
          options: options
            .filter((o) => o.question_id === q.id)
            .map((o) => ({
              id: o.id,
              label: o.label,
              isCorrect: o.is_correct,
              selected: selected.has(o.id),
            })),
        };
      }),
    };
  } catch (err) {
    if (!isMissingRelationError(err)) {
      console.error("[antifraud] getAttemptResult failed:", err);
    }
    return null;
  }
}
