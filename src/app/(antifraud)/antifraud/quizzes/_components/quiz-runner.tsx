"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, GraduationCap, Trophy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { stableShuffle, type QuestionKind } from "@/lib/antifraud/constants";
import { startQuizAttempt, submitQuizAttempt } from "../actions";

/**
 * The quiz runner.
 *
 * Deliberately dumb about correctness: it receives questions and options with
 * NO answer key (the server never sends `is_correct` for an open attempt) and
 * posts the selected option ids back. All grading, all points, and the
 * one-payout-per-attempt guarantee live in `submitQuizAttempt`.
 *
 * Three shapes, one interaction model:
 *   yes_no / single → radio (one selection, picking another replaces it)
 *   multi           → checkbox (any number; scored all-or-nothing server-side)
 */

export type RunnerQuestion = {
  id: string;
  prompt: string;
  kind: QuestionKind;
  points: number;
  options: { id: string; label: string }[];
};

export function QuizRunner({
  quizId,
  title,
  description,
  questions: incomingQuestions,
  pointsAvailable,
  attemptsLeft,
  timeLimitSeconds,
  resumeAttemptId,
  shuffleQuestions = false,
}: {
  quizId: string;
  title: string;
  description: string | null;
  questions: RunnerQuestion[];
  pointsAvailable: number;
  /** null = unlimited retakes. */
  attemptsLeft: number | null;
  timeLimitSeconds: number | null;
  /** An in-progress attempt to resume, if the staff member already started. */
  resumeAttemptId: string | null;
  /**
   * The quiz's `shuffle_questions` setting. The shuffle is applied HERE rather
   * than only on the server because the seed is the attempt id, and on a FIRST
   * attempt that id doesn't exist until the taker presses Start — the server
   * render can only seed it when resuming. Doing both means the order is
   * deterministic per attempt whichever way the page was reached.
   */
  shuffleQuestions?: boolean;
}) {
  const router = useRouter();
  const [attemptId, setAttemptId] = React.useState<string | null>(
    resumeAttemptId,
  );
  const [started, setStarted] = React.useState(Boolean(resumeAttemptId));
  const [busy, setBusy] = React.useState(false);
  const [selections, setSelections] = React.useState<Record<string, string[]>>(
    {},
  );
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(
    resumeAttemptId ? timeLimitSeconds : null,
  );

  // Question order for THIS attempt. Deterministic (seeded by the attempt id),
  // so a reload can't reorder the list under the taker mid-attempt. Falls back
  // to the authored order until an attempt exists — which is only the intro
  // screen, where no question is rendered anyway.
  const questions = React.useMemo(
    () =>
      shuffleQuestions && attemptId
        ? stableShuffle(incomingQuestions, attemptId)
        : incomingQuestions,
    [shuffleQuestions, attemptId, incomingQuestions],
  );

  const answeredCount = questions.filter(
    (q) => (selections[q.id]?.length ?? 0) > 0,
  ).length;
  const allAnswered = answeredCount === questions.length;

  const submit = React.useCallback(
    async (auto: boolean) => {
      if (!attemptId || busy) return;
      setBusy(true);
      try {
        const result = await submitQuizAttempt({
          attemptId,
          answers: questions.map((q) => ({
            questionId: q.id,
            optionIds: selections[q.id] ?? [],
          })),
        });
        toast.success(
          auto
            ? "Time's up — answers submitted"
            : `${result.correctCount}/${result.questionCount} correct`,
        );
        router.push(`/antifraud/quizzes/attempts/${result.attemptId}`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not submit your answers",
        );
        setBusy(false);
      }
    },
    [attemptId, busy, questions, selections, router],
  );

  // Countdown for timed quizzes. Auto-submits at zero so a walked-away tab
  // still records whatever was answered rather than leaving the attempt open
  // forever (which would block a retake).
  React.useEffect(() => {
    if (secondsLeft === null || !started) return;
    if (secondsLeft <= 0) {
      void submit(true);
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => (s ?? 1) - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, started, submit]);

  async function handleStart() {
    setBusy(true);
    try {
      const { id } = await startQuizAttempt({ quizId });
      setAttemptId(id);
      setStarted(true);
      setSecondsLeft(timeLimitSeconds);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  function toggle(question: RunnerQuestion, optionId: string) {
    setSelections((prev) => {
      const current = prev[question.id] ?? [];
      if (question.kind === "multi") {
        return {
          ...prev,
          [question.id]: current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId],
        };
      }
      return { ...prev, [question.id]: [optionId] };
    });
  }

  // ── Intro ─────────────────────────────────────────────────────────
  if (!started) {
    return (
      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
            <GraduationCap className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        <dl className="grid gap-3 sm:grid-cols-3">
          <Fact label="Questions" value={String(questions.length)} />
          <Fact label="Points on offer" value={String(pointsAvailable)} />
          <Fact
            label="Attempts left"
            value={attemptsLeft === null ? "Unlimited" : String(attemptsLeft)}
          />
        </dl>

        {timeLimitSeconds != null && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            Timed: {Math.round(timeLimitSeconds / 60)} minutes once you start.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          One point per correct answer. Multiple-choice questions have to be
          exactly right — no partial credit.
        </p>

        <Button
          onClick={handleStart}
          disabled={busy || questions.length === 0}
          className="w-full sm:w-auto"
        >
          {busy ? "Starting…" : "Start quiz"}
        </Button>
      </div>
    );
  }

  // ── Runner ────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <span className="text-xs font-medium">
          {answeredCount} / {questions.length} answered
        </span>
        <div className="flex items-center gap-3">
          {secondsLeft !== null && (
            <span
              className={cn(
                "flex items-center gap-1 text-xs font-semibold tabular-nums",
                secondsLeft <= 30 ? "text-rose-500" : "text-muted-foreground",
              )}
            >
              <Clock className="size-3.5" />
              {formatClock(secondsLeft)}
            </span>
          )}
          <Button size="sm" onClick={() => submit(false)} disabled={busy}>
            {busy ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </div>

      <ol className="space-y-3">
        {questions.map((question, index) => {
          const selected = selections[question.id] ?? [];
          return (
            <li
              key={question.id}
              className="rounded-xl border border-border/60 bg-card p-4"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-bold text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-relaxed">
                    {question.prompt}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {question.kind === "multi"
                      ? "Select every answer that applies"
                      : question.kind === "yes_no"
                        ? "Yes or no"
                        : "Select one answer"}
                    {" · "}
                    {question.points} pt{question.points === 1 ? "" : "s"}
                  </p>
                </div>
              </div>

              <div
                className={cn(
                  "mt-3 grid gap-2",
                  question.kind === "yes_no" ? "sm:grid-cols-2" : "",
                )}
              >
                {question.options.map((option) => {
                  const isSelected = selected.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(question, option.id)}
                      disabled={busy}
                      aria-pressed={isSelected}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-60",
                        isSelected
                          ? "border-cyan-500/50 bg-cyan-500/10 text-foreground"
                          : "border-border/60 bg-background hover:bg-accent/50",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center border",
                          question.kind === "multi"
                            ? "rounded-[4px]"
                            : "rounded-full",
                          isSelected
                            ? "border-cyan-500 bg-cyan-500 text-white"
                            : "border-border",
                        )}
                      >
                        {isSelected && <CheckCircle2 className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-card px-3 py-3">
        <span className="text-xs text-muted-foreground">
          {allAnswered
            ? "Everything answered — submit when you're ready."
            : `${questions.length - answeredCount} question${
                questions.length - answeredCount === 1 ? "" : "s"
              } left. Unanswered questions score zero.`}
        </span>
        <Button onClick={() => submit(false)} disabled={busy}>
          <Trophy className="mr-2 size-4" />
          {busy ? "Submitting…" : "Submit answers"}
        </Button>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm font-semibold">{value}</dd>
    </div>
  );
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
