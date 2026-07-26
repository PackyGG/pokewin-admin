"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ALL_ADMIN_ROLES } from "@/lib/admin-roles";
import { hrefForCurrentHost } from "@/lib/use-app-host";
import { createQuiz, updateQuiz } from "../actions";

/**
 * Create / edit a quiz's settings. Used both from the manager list (create) and
 * from the editor page (edit) — same form, same validation, one component.
 *
 * Questions are authored on the editor page; this dialog only owns the quiz's
 * own settings so the two concerns don't fight over one giant form.
 */

export type QuizFormValues = {
  quizId?: string;
  title: string;
  description: string;
  passPercent: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleQuestions: boolean;
  audienceRoles: string[];
};

const EMPTY: QuizFormValues = {
  title: "",
  description: "",
  passPercent: 70,
  maxAttempts: 1,
  timeLimitMinutes: 0,
  shuffleQuestions: false,
  audienceRoles: [],
};

export function QuizFormDialog({
  initial,
  mode = "create",
}: {
  initial?: QuizFormValues;
  mode?: "create" | "edit";
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [values, setValues] = React.useState<QuizFormValues>(initial ?? EMPTY);

  // Re-seed when the dialog opens so an edit form never shows stale values
  // after a server refresh.
  React.useEffect(() => {
    if (open) setValues(initial ?? EMPTY);
  }, [open, initial]);

  function set<K extends keyof QuizFormValues>(
    key: K,
    value: QuizFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleRole(role: string) {
    setValues((prev) => ({
      ...prev,
      audienceRoles: prev.audienceRoles.includes(role)
        ? prev.audienceRoles.filter((r) => r !== role)
        : [...prev.audienceRoles, role],
    }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const payload = {
        title: values.title.trim(),
        description: values.description.trim(),
        passPercent: values.passPercent,
        maxAttempts: values.maxAttempts,
        timeLimitMinutes: values.timeLimitMinutes,
        shuffleQuestions: values.shuffleQuestions,
        audienceRoles: values.audienceRoles,
      };
      if (mode === "edit" && values.quizId) {
        await updateQuiz({ ...payload, quizId: values.quizId });
        toast.success("Quiz updated");
        setOpen(false);
        router.refresh();
      } else {
        const { id } = await createQuiz(payload);
        toast.success("Draft created — add questions next");
        setOpen(false);
        router.push(
          hrefForCurrentHost(`/staff/quiz-manager/${id}`),
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the quiz");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant={mode === "edit" ? "outline" : "default"} />
        }
      >
        {mode === "edit" ? (
          <>
            <Pencil className="mr-2 size-4" />
            Settings
          </>
        ) : (
          <>
            <Plus className="mr-2 size-4" />
            New quiz
          </>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {mode === "edit" ? "Quiz settings" : "New quiz"}
            </DialogTitle>
            <DialogDescription>
              Staff earn one point per correct answer. A quiz stays a draft (and
              invisible to staff) until you publish it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="quiz-title">Title</Label>
              <Input
                id="quiz-title"
                value={values.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="e.g. Chargeback red flags"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="quiz-description">Description</Label>
              <Textarea
                id="quiz-description"
                value={values.description}
                onChange={(e) => set("description", e.target.value)}
                rows={2}
                placeholder="What this quiz covers (shown on the card and in the notification)."
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="quiz-pass">Pass mark %</Label>
                <Input
                  id="quiz-pass"
                  type="number"
                  min={0}
                  max={100}
                  value={values.passPercent}
                  onChange={(e) => set("passPercent", Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quiz-attempts">Attempts</Label>
                <Input
                  id="quiz-attempts"
                  type="number"
                  min={0}
                  max={50}
                  value={values.maxAttempts}
                  onChange={(e) => set("maxAttempts", Number(e.target.value))}
                />
                <p className="text-[10px] text-muted-foreground">0 = unlimited</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quiz-time">Time limit (min)</Label>
                <Input
                  id="quiz-time"
                  type="number"
                  min={0}
                  max={240}
                  value={values.timeLimitMinutes}
                  onChange={(e) =>
                    set("timeLimitMinutes", Number(e.target.value))
                  }
                />
                <p className="text-[10px] text-muted-foreground">0 = untimed</p>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={values.shuffleQuestions}
                onCheckedChange={(checked) =>
                  set("shuffleQuestions", checked === true)
                }
              />
              <span>Shuffle question order per attempt</span>
            </label>

            <div className="space-y-1.5">
              <Label>Who can take it</Label>
              <p className="text-[11px] text-muted-foreground">
                Leave everything unticked for the whole staff team.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ALL_ADMIN_ROLES.map((role) => {
                  const active = values.audienceRoles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => toggleRole(role)}
                      className={
                        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors " +
                        (active
                          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
                          : "border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground")
                      }
                    >
                      {role.replace("_", " ")}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Saving…" : mode === "edit" ? "Save" : "Create draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
