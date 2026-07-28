"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus, UserCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { hrefForCurrentHost } from "@/lib/use-app-host";
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  type ReviewStatus,
} from "@/lib/antifraud/constants";
import {
  addReviewNote,
  assignReview,
  updateReviewStatus,
} from "../actions";

/**
 * The working controls on a case: move its status, hand it to someone (or take
 * it), and add notes.
 *
 * Everything routes through the server actions in `../actions.ts`, which
 * re-verify workspace access, write an append-only note describing the change,
 * and mirror the important ones into `admin_audit_events`. Account mutations
 * live in the separate quick-action strip above these workflow controls.
 */

export function CaseControls({
  reviewId,
  status,
  assignedTo,
  viewerId,
  analysts,
}: {
  reviewId: string;
  status: string;
  assignedTo: string | null;
  viewerId: string;
  analysts: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [resolution, setResolution] = React.useState("");
  const [note, setNote] = React.useState("");
  const statusAttempt = React.useRef<{
    status: ReviewStatus;
    resolution: string;
    key: string;
  } | null>(null);

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

  const isTerminalTarget = (value: string) =>
    value === "cleared" || value === "flagged";

  const trimmedResolution = resolution.trim();

  /**
   * Status changes get their own handler because they carry two things the
   * generic `run` does not: the status the analyst was LOOKING AT (so the
   * server can reject a stale tab instead of silently overwriting someone
   * else's verdict) and a structured "that player already has a live case"
   * answer, which becomes a toast with a link to the case that holds the slot.
   */
  async function changeStatus(next: ReviewStatus) {
    const submittedResolution = isTerminalTarget(next)
      ? trimmedResolution
      : "";
    if (
      statusAttempt.current?.status !== next ||
      statusAttempt.current.resolution !== submittedResolution
    ) {
      statusAttempt.current = {
        status: next,
        resolution: submittedResolution,
        key: crypto.randomUUID(),
      };
    }
    setPending(`status-${next}`);
    try {
      const result = await updateReviewStatus({
        reviewId,
        status: next,
        expectedStatus: status,
        resolution: submittedResolution,
        idempotencyKey: statusAttempt.current.key,
      });
      if (!result.ok) {
        statusAttempt.current = null;
        toast.error(
          result.message,
          result.conflictReviewId
            ? {
                action: {
                  label: "Open live case",
                  onClick: () =>
                    router.push(
                      hrefForCurrentHost(
                        `/antifraud/reviews/${result.conflictReviewId}`,
                      ),
                    ),
                },
              }
            : undefined,
        );
        return;
      }
      // Clear the box on success. Left as-is, a rationale typed for one
      // action silently became the rationale stored for the next one.
      statusAttempt.current = null;
      setResolution("");
      toast.success(`Marked ${REVIEW_STATUS_LABELS[next].toLowerCase()}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5 rounded-xl border border-border/60 bg-card p-4">
      {/* ── Status ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Status
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {REVIEW_STATUSES.map((value) => {
            // A verdict without a written conclusion closes the case and
            // records nothing about why — blocked here AND in the action's
            // schema (the server side is the real gate).
            const needsConclusion =
              isTerminalTarget(value) && trimmedResolution.length === 0;
            return (
              <button
                key={value}
                type="button"
                disabled={pending !== null || value === status || needsConclusion}
                title={
                  needsConclusion
                    ? "Write your conclusion below first"
                    : undefined
                }
                onClick={() => void changeStatus(value)}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                  value === status
                    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
                    : "border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground",
                )}
              >
                {pending === `status-${value}`
                  ? "…"
                  : REVIEW_STATUS_LABELS[value]}
              </button>
            );
          })}
        </div>
        <Textarea
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          rows={2}
          placeholder="What did you conclude? (required for Cleared / Flagged)"
          className="text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          Cleared and Flagged need a conclusion. Moving a case back to Open,
          In review or Escalated withdraws the previous verdict and clears it.
        </p>
      </div>

      {/* ── Assignment ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label
          htmlFor="case-assign-select"
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Assigned to
        </Label>
        <div className="flex flex-wrap gap-2">
          <Select
            value={assignedTo ?? "__none"}
            onValueChange={(v) => {
              const next = !v || v === "__none" ? null : v;
              if (next === assignedTo) return;
              void run(
                "assign",
                () => assignReview({ reviewId, adminUserId: next }),
                next ? "Case assigned" : "Case unassigned",
              );
            }}
          >
            <SelectTrigger
              id="case-assign-select"
              className="min-w-0 flex-1"
              disabled={pending !== null}
            >
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Unassigned</SelectItem>
              {analysts.map((analyst) => (
                <SelectItem key={analyst.id} value={analyst.id}>
                  {analyst.label}
                  {analyst.id === viewerId && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (you)
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {assignedTo !== viewerId && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                run(
                  "take",
                  () => assignReview({ reviewId, adminUserId: viewerId }),
                  "You picked this case up",
                )
              }
            >
              <UserCheck className="mr-2 size-4" />
              Take it
            </Button>
          )}
        </div>
      </div>

      {/* ── Note ───────────────────────────────────────────────────── */}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const body = note.trim();
          if (body.length < 2) {
            toast.error("Write something first");
            return;
          }
          void run(
            "note",
            async () => {
              await addReviewNote({ reviewId, body });
              setNote("");
            },
            "Note added",
          );
        }}
      >
        <Label
          htmlFor="case-note"
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Add a note
        </Label>
        <Textarea
          id="case-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="What you checked and what you found."
          className="text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          className="w-full"
        >
          <MessageSquarePlus className="mr-2 size-4" />
          {pending === "note" ? "Saving…" : "Add note"}
        </Button>
      </form>
    </div>
  );
}
