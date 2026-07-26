"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Send, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { deleteQuiz, setQuizStatus } from "../actions";

/**
 * Publish / archive / delete controls for one quiz.
 *
 * Publishing is the notifying action (the server fans a "new quiz" ping out to
 * the audience), so it is the primary button. Delete is refused server-side
 * once anyone has taken the quiz — archiving is the right move there, and the
 * error says so.
 */
export function QuizStatusActions({
  quizId,
  status,
  hasAttempts,
}: {
  quizId: string;
  status: string;
  hasAttempts: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  async function run(key: string, fn: () => Promise<void>, success: string) {
    setPending(key);
    try {
      await fn();
      toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== "published" && (
        <Button
          size="sm"
          disabled={pending !== null}
          onClick={() =>
            run(
              "publish",
              () => setQuizStatus({ quizId, status: "published" }),
              "Published — staff have been notified",
            )
          }
        >
          <Send className="mr-2 size-4" />
          {pending === "publish" ? "Publishing…" : "Publish"}
        </Button>
      )}

      {status === "published" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() =>
            run(
              "unpublish",
              () => setQuizStatus({ quizId, status: "draft" }),
              "Back to draft",
            )
          }
        >
          <Undo2 className="mr-2 size-4" />
          Unpublish
        </Button>
      )}

      {status !== "archived" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() =>
            run(
              "archive",
              () => setQuizStatus({ quizId, status: "archived" }),
              "Archived",
            )
          }
        >
          <Archive className="mr-2 size-4" />
          Archive
        </Button>
      )}

      {status === "archived" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() =>
            run(
              "restore",
              () => setQuizStatus({ quizId, status: "draft" }),
              "Restored as a draft",
            )
          }
        >
          <Undo2 className="mr-2 size-4" />
          Restore
        </Button>
      )}

      {!hasAttempts &&
        (confirmingDelete ? (
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="destructive"
              disabled={pending !== null}
              onClick={() =>
                run("delete", () => deleteQuiz({ quizId }), "Quiz deleted")
              }
            >
              {pending === "delete" ? "Deleting…" : "Really delete"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={pending !== null}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="mr-2 size-4" />
            Delete
          </Button>
        ))}
    </div>
  );
}
