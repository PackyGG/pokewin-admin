"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  QUESTION_KINDS,
  QUESTION_KIND_LABELS,
  type QuestionKind,
} from "@/lib/staff/constants";
import {
  addQuizQuestion,
  deleteQuizQuestion,
  moveQuizQuestion,
  updateQuizQuestion,
} from "../../actions";

/**
 * The question authoring surface.
 *
 * Three shapes, one editor:
 *   yes_no → the two options are fixed to Yes / No; the author only picks which
 *            one is right (this is the "yes/no button selection" case)
 *   single → N options, exactly one correct (radio semantics)
 *   multi  → N options, any number correct (checkbox semantics)
 *
 * The shape rules are enforced AGAIN on the server (`validateShape`) — the UI
 * makes the right thing easy, the server makes the wrong thing impossible.
 */

type EditorOption = { label: string; isCorrect: boolean };

export type WorkbenchQuestion = {
  id: string;
  prompt: string;
  kind: QuestionKind;
  points: number;
  explanation: string | null;
  options: { id: string; label: string; isCorrect: boolean }[];
};

const YES_NO_LABELS = ["Yes", "No"] as const;

function blankOptions(kind: QuestionKind): EditorOption[] {
  if (kind === "yes_no") {
    return [
      { label: "Yes", isCorrect: true },
      { label: "No", isCorrect: false },
    ];
  }
  return [
    { label: "", isCorrect: true },
    { label: "", isCorrect: false },
  ];
}

export function QuestionWorkbench({
  quizId,
  questions,
}: {
  quizId: string;
  questions: WorkbenchQuestion[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(questions.length === 0);
  const [pending, setPending] = React.useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>, success: string) {
    setPending(key);
    try {
      await fn();
      toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      throw err;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {questions.map((question, index) =>
        editingId === question.id ? (
          <QuestionForm
            key={question.id}
            title={`Edit question ${index + 1}`}
            initial={{
              prompt: question.prompt,
              kind: question.kind,
              points: question.points,
              explanation: question.explanation ?? "",
              options: question.options.map((o) => ({
                label: o.label,
                isCorrect: o.isCorrect,
              })),
            }}
            busy={pending !== null}
            onCancel={() => setEditingId(null)}
            onSubmit={async (values) => {
              await run(
                "update",
                () =>
                  updateQuizQuestion({
                    quizId,
                    questionId: question.id,
                    ...values,
                  }),
                "Question updated",
              );
              setEditingId(null);
            }}
          />
        ) : (
          <article
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
                  {QUESTION_KIND_LABELS[question.kind]} · {question.points} pt
                  {question.points === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  label="Move up"
                  disabled={index === 0 || pending !== null}
                  onClick={() =>
                    run(
                      "move",
                      () =>
                        moveQuizQuestion({
                          quizId,
                          questionId: question.id,
                          direction: "up",
                        }),
                      "Moved",
                    ).catch(() => {})
                  }
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Move down"
                  disabled={index === questions.length - 1 || pending !== null}
                  onClick={() =>
                    run(
                      "move",
                      () =>
                        moveQuizQuestion({
                          quizId,
                          questionId: question.id,
                          direction: "down",
                        }),
                      "Moved",
                    ).catch(() => {})
                  }
                >
                  <ArrowDown className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Edit"
                  disabled={pending !== null}
                  onClick={() => setEditingId(question.id)}
                >
                  <Pencil className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Delete"
                  disabled={pending !== null}
                  destructive
                  onClick={() =>
                    run(
                      "delete",
                      () =>
                        deleteQuizQuestion({
                          quizId,
                          questionId: question.id,
                        }),
                      "Question deleted",
                    ).catch(() => {})
                  }
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            </div>

            <ul className="mt-3 space-y-1.5">
              {question.options.map((option) => (
                <li
                  key={option.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
                    option.isCorrect
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-border/50",
                  )}
                >
                  <span className="min-w-0 flex-1">{option.label}</span>
                  {option.isCorrect && (
                    <Check className="size-3.5 shrink-0 text-emerald-500" />
                  )}
                </li>
              ))}
            </ul>

            {question.explanation && (
              <p className="mt-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {question.explanation}
              </p>
            )}
          </article>
        ),
      )}

      {adding ? (
        <QuestionForm
          title="New question"
          initial={{
            prompt: "",
            kind: "single",
            points: 1,
            explanation: "",
            options: blankOptions("single"),
          }}
          busy={pending !== null}
          onCancel={() => setAdding(false)}
          onSubmit={async (values) => {
            await run(
              "add",
              () => addQuizQuestion({ quizId, ...values }),
              "Question added",
            );
            // Stay open so a run of questions can be typed without re-clicking.
          }}
          resetAfterSubmit
        />
      ) : (
        <Button
          variant="outline"
          className="w-full"
          onClick={() => setAdding(true)}
          disabled={pending !== null}
        >
          <Plus className="mr-2 size-4" />
          Add question
        </Button>
      )}
    </div>
  );
}

// ─── Form ─────────────────────────────────────────────────────────────

type FormValues = {
  prompt: string;
  kind: QuestionKind;
  points: number;
  explanation: string;
  options: EditorOption[];
};

function QuestionForm({
  title,
  initial,
  busy,
  onCancel,
  onSubmit,
  resetAfterSubmit,
}: {
  title: string;
  initial: FormValues;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: FormValues) => Promise<void>;
  resetAfterSubmit?: boolean;
}) {
  const [values, setValues] = React.useState<FormValues>(initial);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Switching shape rewrites the options so the form can never be in an
   * impossible state: yes/no snaps to the fixed pair, and single-choice keeps
   * only the FIRST correct answer (picking a second in a radio question is
   * meaningless).
   */
  function changeKind(kind: QuestionKind) {
    setValues((prev) => {
      if (kind === "yes_no") {
        const yesWasCorrect = prev.options[0]?.isCorrect ?? true;
        return {
          ...prev,
          kind,
          options: YES_NO_LABELS.map((label, i) => ({
            label,
            isCorrect: i === 0 ? yesWasCorrect : !yesWasCorrect,
          })),
        };
      }
      let options = prev.options;
      if (prev.kind === "yes_no") options = blankOptions(kind);
      if (kind === "single") {
        let seen = false;
        options = options.map((option) => {
          if (option.isCorrect && !seen) {
            seen = true;
            return option;
          }
          return { ...option, isCorrect: false };
        });
        if (!seen && options.length > 0) {
          options = options.map((o, i) => ({ ...o, isCorrect: i === 0 }));
        }
      }
      return { ...prev, kind, options };
    });
  }

  function toggleCorrect(index: number) {
    setValues((prev) => ({
      ...prev,
      options: prev.options.map((option, i) => {
        if (prev.kind === "multi") {
          return i === index ? { ...option, isCorrect: !option.isCorrect } : option;
        }
        // Radio semantics for yes_no + single.
        return { ...option, isCorrect: i === index };
      }),
    }));
  }

  function setOptionLabel(index: number, label: string) {
    setValues((prev) => ({
      ...prev,
      options: prev.options.map((option, i) =>
        i === index ? { ...option, label } : option,
      ),
    }));
  }

  function addOption() {
    setValues((prev) => ({
      ...prev,
      options: [...prev.options, { label: "", isCorrect: false }],
    }));
  }

  function removeOption(index: number) {
    setValues((prev) => {
      const options = prev.options.filter((_, i) => i !== index);
      // Never leave a question with no correct answer marked.
      if (!options.some((o) => o.isCorrect) && options.length > 0) {
        options[0] = { ...options[0], isCorrect: true };
      }
      return { ...prev, options };
    });
  }

  const isYesNo = values.kind === "yes_no";

  return (
    <form
      className="space-y-4 rounded-xl border border-cyan-500/30 bg-card p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit({
          ...values,
          prompt: values.prompt.trim(),
          explanation: values.explanation.trim(),
          options: values.options.map((o) => ({
            ...o,
            label: o.label.trim(),
          })),
        });
        if (resetAfterSubmit) {
          setValues({
            prompt: "",
            kind: values.kind,
            points: values.points,
            explanation: "",
            options: blankOptions(values.kind),
          });
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="q-prompt">Question</Label>
        <Textarea
          id="q-prompt"
          value={values.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={2}
          placeholder="What do you want to ask?"
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="q-kind">Answer type</Label>
          <Select
            value={values.kind}
            onValueChange={(v) => v && changeKind(v as QuestionKind)}
          >
            <SelectTrigger id="q-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUESTION_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {QUESTION_KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="q-points">Points</Label>
          <Input
            id="q-points"
            type="number"
            min={1}
            max={20}
            value={values.points}
            onChange={(e) => set("points", Number(e.target.value))}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>
          Answers
          <span className="ml-1.5 font-normal text-muted-foreground">
            {values.kind === "multi"
              ? "— tick every correct one"
              : "— tick the correct one"}
          </span>
        </Label>
        {values.options.map((option, index) => (
          <div key={index} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => toggleCorrect(index)}
              aria-label={
                option.isCorrect ? "Marked correct" : "Mark as correct"
              }
              className={cn(
                "flex size-8 shrink-0 items-center justify-center border transition-colors",
                values.kind === "multi" ? "rounded-md" : "rounded-full",
                option.isCorrect
                  ? "border-emerald-500 bg-emerald-500 text-white"
                  : "border-border bg-background hover:bg-accent",
              )}
            >
              <Check className="size-3.5" />
            </button>
            <Input
              value={option.label}
              onChange={(e) => setOptionLabel(index, e.target.value)}
              placeholder={`Answer ${index + 1}`}
              disabled={isYesNo}
              required
            />
            {!isYesNo && values.options.length > 2 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => removeOption(index)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
        {!isYesNo && values.options.length < 10 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={addOption}
            className="w-full"
          >
            <Plus className="mr-2 size-3.5" />
            Add answer
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="q-explanation">Explanation (optional)</Label>
        <Textarea
          id="q-explanation"
          value={values.explanation}
          onChange={(e) => set("explanation", e.target.value)}
          rows={2}
          placeholder="Shown on the result screen next to the right answer."
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save question"}
        </Button>
      </div>
    </form>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40",
        destructive && "hover:bg-rose-500/10 hover:text-rose-500",
      )}
    >
      {children}
    </button>
  );
}
