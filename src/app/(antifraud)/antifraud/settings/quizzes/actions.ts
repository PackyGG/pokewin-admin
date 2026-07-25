"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  notifyStaff,
  staffBroadcastRecipients,
} from "@/lib/antifraud/notifications";
import { QUESTION_KINDS } from "@/lib/antifraud/quiz";
import { ALL_ADMIN_ROLES } from "@/lib/admin-roles";

/**
 * Quiz authoring — OWNER / ADMIN ONLY.
 *
 * Every action goes through `requireAntifraudManager`, which is the workspace
 * gate PLUS the owner/admin check. Taking a quiz is open to every staff member;
 * writing one is not.
 *
 * Publishing is the one action with a side effect beyond the row: it fans a
 * "new quiz" notification out to the staff the quiz is addressed to (in-app
 * plus their verified Discord/Telegram, per their own preferences).
 */

const uuid = z.string().uuid("Invalid id");

const quizMetaSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Give the quiz a title")
    .max(120, "Keep the title under 120 characters"),
  description: z
    .string()
    .trim()
    .max(1000, "Keep the description under 1000 characters")
    .optional()
    .or(z.literal("")),
  passPercent: z.coerce
    .number()
    .int()
    .min(0, "Pass mark can't be negative")
    .max(100, "Pass mark is a percentage"),
  maxAttempts: z.coerce
    .number()
    .int()
    .min(0, "Use 0 for unlimited")
    .max(50, "That's a lot of attempts"),
  timeLimitMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(240, "Keep the time limit under 4 hours")
    .optional(),
  shuffleQuestions: z.boolean().optional(),
  audienceRoles: z.array(z.enum(ALL_ADMIN_ROLES as unknown as [string, ...string[]])).max(10),
});

/** Create a draft quiz. Drafts are invisible to staff until published. */
export async function createQuiz(input: unknown): Promise<{ id: string }> {
  const session = await requireAntifraudManager();
  const parsed = quizMetaSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const data = parsed.data;

  const created = await adminDb.staff_quizzes.create({
    data: {
      title: data.title,
      description: data.description ? data.description : null,
      status: "draft",
      pass_percent: data.passPercent,
      max_attempts: data.maxAttempts,
      time_limit_seconds:
        data.timeLimitMinutes && data.timeLimitMinutes > 0
          ? data.timeLimitMinutes * 60
          : null,
      shuffle_questions: data.shuffleQuestions ?? false,
      audience_roles: data.audienceRoles,
      created_by: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_quiz_created",
    metadata: { quizId: created.id, title: data.title },
  });

  revalidatePath("/antifraud/settings/quizzes");
  return { id: created.id };
}

const updateQuizSchema = quizMetaSchema.extend({ quizId: uuid });

/** Edit a quiz's settings. Allowed in any state — content is edited below. */
export async function updateQuiz(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = updateQuizSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { quizId, ...data } = parsed.data;

  await adminDb.staff_quizzes.update({
    where: { id: quizId },
    data: {
      title: data.title,
      description: data.description ? data.description : null,
      pass_percent: data.passPercent,
      max_attempts: data.maxAttempts,
      time_limit_seconds:
        data.timeLimitMinutes && data.timeLimitMinutes > 0
          ? data.timeLimitMinutes * 60
          : null,
      shuffle_questions: data.shuffleQuestions ?? false,
      audience_roles: data.audienceRoles,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_quiz_updated",
    metadata: { quizId, title: data.title },
  });

  revalidatePath("/antifraud/settings/quizzes");
  revalidatePath(`/antifraud/settings/quizzes/${quizId}`);
}

const statusSchema = z.object({
  quizId: uuid,
  status: z.enum(["draft", "published", "archived"]),
});

/**
 * Move a quiz between draft / published / archived.
 *
 * Publishing for the FIRST time stamps `published_at` and notifies the
 * audience. Re-publishing an already-published-once quiz does NOT re-notify —
 * un-archiving something shouldn't ping everyone again.
 */
export async function setQuizStatus(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { quizId, status } = parsed.data;

  const quiz = await adminDb.staff_quizzes.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      published_at: true,
      audience_roles: true,
    },
  });
  if (!quiz) throw new Error("That quiz no longer exists");

  if (status === "published") {
    const questionCount = await adminDb.staff_quiz_questions.count({
      where: { quiz_id: quizId },
    });
    if (questionCount === 0) {
      throw new Error("Add at least one question before publishing");
    }
    // A question with no correct option can never be answered right — that is
    // an authoring mistake, and finding it after 30 people took the quiz is
    // far worse than blocking the publish here.
    const questions = await adminDb.staff_quiz_questions.findMany({
      where: { quiz_id: quizId },
      select: { id: true, prompt: true },
    });
    const options = await adminDb.staff_quiz_options.findMany({
      where: { question_id: { in: questions.map((q) => q.id) } },
      select: { question_id: true, is_correct: true },
    });
    const correctByQuestion = new Set(
      options.filter((o) => o.is_correct).map((o) => o.question_id),
    );
    const broken = questions.find((q) => !correctByQuestion.has(q.id));
    if (broken) {
      throw new Error(
        `"${broken.prompt.slice(0, 60)}" has no correct answer marked`,
      );
    }
  }

  const firstPublish = status === "published" && quiz.published_at === null;

  await adminDb.staff_quizzes.update({
    where: { id: quizId },
    data: {
      status,
      published_at: firstPublish ? new Date() : undefined,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_quiz_status_changed",
    metadata: { quizId, from: quiz.status, to: status },
  });

  if (firstPublish) {
    const recipients = await staffBroadcastRecipients(
      quiz.audience_roles.length > 0 ? quiz.audience_roles : undefined,
    );
    if (recipients.length > 0) {
      await notifyStaff({
        recipients,
        kind: "quiz_published",
        title: `New quiz: ${quiz.title}`,
        body: quiz.description ?? "A new quiz is available. One point per correct answer.",
        href: `/antifraud/quizzes/${quizId}`,
        metadata: { quizId },
      });
    }
  }

  revalidatePath("/antifraud/settings/quizzes");
  revalidatePath(`/antifraud/settings/quizzes/${quizId}`);
  revalidatePath("/antifraud/quizzes");
}

/**
 * Delete a quiz outright. Refused once anyone has taken it — deleting would
 * take their points' explanation with it (the ledger event survives, but the
 * attempt it points at would be gone). Archive instead.
 */
export async function deleteQuiz(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = z.object({ quizId: uuid }).safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { quizId } = parsed.data;

  const attempts = await adminDb.staff_quiz_attempts.count({
    where: { quiz_id: quizId },
  });
  if (attempts > 0) {
    throw new Error(
      "People have already taken this quiz — archive it instead of deleting it.",
    );
  }

  await adminDb.staff_quizzes.delete({ where: { id: quizId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_quiz_deleted",
    metadata: { quizId },
  });

  revalidatePath("/antifraud/settings/quizzes");
}

// ─── Questions ────────────────────────────────────────────────────────

const optionSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "An answer can't be blank")
    .max(200, "Keep answers under 200 characters"),
  isCorrect: z.boolean(),
});

const questionSchema = z.object({
  quizId: uuid,
  kind: z.enum(QUESTION_KINDS),
  prompt: z
    .string()
    .trim()
    .min(4, "Write the question")
    .max(500, "Keep questions under 500 characters"),
  explanation: z
    .string()
    .trim()
    .max(500, "Keep the explanation under 500 characters")
    .optional()
    .or(z.literal("")),
  points: z.coerce.number().int().min(1, "At least 1 point").max(20),
  options: z.array(optionSchema).min(2, "At least two answers").max(10),
});

/** Shape rules shared by add + edit. */
function validateShape(
  kind: (typeof QUESTION_KINDS)[number],
  options: { label: string; isCorrect: boolean }[],
) {
  const correct = options.filter((o) => o.isCorrect).length;
  if (correct === 0) throw new Error("Mark at least one correct answer");
  if (kind === "yes_no") {
    if (options.length !== 2) {
      throw new Error("A yes/no question has exactly two answers");
    }
    if (correct !== 1) throw new Error("A yes/no question has one right answer");
  }
  if (kind === "single" && correct !== 1) {
    throw new Error("A single-choice question has exactly one right answer");
  }
}

export async function addQuizQuestion(input: unknown): Promise<void> {
  await requireAntifraudManager();
  const parsed = questionSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const data = parsed.data;
  validateShape(data.kind, data.options);

  const last = await adminDb.staff_quiz_questions.findFirst({
    where: { quiz_id: data.quizId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  await adminDb.$transaction(async (tx) => {
    const question = await tx.staff_quiz_questions.create({
      data: {
        quiz_id: data.quizId,
        position: (last?.position ?? -1) + 1,
        prompt: data.prompt,
        kind: data.kind,
        explanation: data.explanation ? data.explanation : null,
        points: data.points,
      },
      select: { id: true },
    });
    await tx.staff_quiz_options.createMany({
      data: data.options.map((option, index) => ({
        question_id: question.id,
        position: index,
        label: option.label,
        is_correct: option.isCorrect,
      })),
    });
  });

  revalidatePath(`/antifraud/settings/quizzes/${data.quizId}`);
}

const updateQuestionSchema = questionSchema.extend({ questionId: uuid });

/**
 * Replace a question and its options.
 *
 * Options are re-created rather than patched, which changes their ids. That is
 * safe because every SUBMITTED attempt stores its own frozen answer rows (with
 * the option ids as they were) and its own score — re-authoring can never
 * retroactively rewrite a past result.
 */
export async function updateQuizQuestion(input: unknown): Promise<void> {
  await requireAntifraudManager();
  const parsed = updateQuestionSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const data = parsed.data;
  validateShape(data.kind, data.options);

  await adminDb.$transaction(async (tx) => {
    await tx.staff_quiz_questions.update({
      where: { id: data.questionId },
      data: {
        prompt: data.prompt,
        kind: data.kind,
        explanation: data.explanation ? data.explanation : null,
        points: data.points,
      },
    });
    await tx.staff_quiz_options.deleteMany({
      where: { question_id: data.questionId },
    });
    await tx.staff_quiz_options.createMany({
      data: data.options.map((option, index) => ({
        question_id: data.questionId,
        position: index,
        label: option.label,
        is_correct: option.isCorrect,
      })),
    });
  });

  revalidatePath(`/antifraud/settings/quizzes/${data.quizId}`);
}

export async function deleteQuizQuestion(input: unknown): Promise<void> {
  await requireAntifraudManager();
  const parsed = z
    .object({ quizId: uuid, questionId: uuid })
    .safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await adminDb.staff_quiz_questions.delete({
    where: { id: parsed.data.questionId },
  });

  revalidatePath(`/antifraud/settings/quizzes/${parsed.data.quizId}`);
}

/** Move a question up or down in the list. */
export async function moveQuizQuestion(input: unknown): Promise<void> {
  await requireAntifraudManager();
  const parsed = z
    .object({
      quizId: uuid,
      questionId: uuid,
      direction: z.enum(["up", "down"]),
    })
    .safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { quizId, questionId, direction } = parsed.data;

  const questions = await adminDb.staff_quiz_questions.findMany({
    where: { quiz_id: quizId },
    orderBy: { position: "asc" },
    select: { id: true, position: true },
  });
  const index = questions.findIndex((q) => q.id === questionId);
  if (index === -1) return;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= questions.length) return;

  // Re-number the whole list from the swapped order. Cheap (a quiz is tens of
  // rows at most) and leaves positions dense, so a later insert is trivial.
  const reordered = [...questions];
  [reordered[index], reordered[swapWith]] = [
    reordered[swapWith],
    reordered[index],
  ];

  await adminDb.$transaction(
    reordered.map((question, position) =>
      adminDb.staff_quiz_questions.update({
        where: { id: question.id },
        data: { position },
      }),
    ),
  );

  revalidatePath(`/antifraud/settings/quizzes/${quizId}`);
}
