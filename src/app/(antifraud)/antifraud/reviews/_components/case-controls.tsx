"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock3, MessageSquarePlus, UserCheck } from "lucide-react";
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
  postponeReview,
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
        const conflictReviewId = result.conflictReviewId;
        toast.error(
          result.message,
          conflictReviewId
            ? {
                action: {
                  label: "Open live case",
                  onClick: () =>
                    router.push(
                      hrefForCurrentHost(
                        `/antifraud/reviews?review=${encodeURIComponent(conflictReviewId)}`,
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
      // Clearing a case releases the player's withdrawal locks. Say which of
      // the two happened — especially when the release did NOT land.
      if (result.withdrawalRelease === "failed") {
        toast.warning(
          "Case cleared, but withdrawals could not be unlocked — unlock them on the user page.",
        );
      } else if (result.withdrawalRelease === "kyc_gated") {
        toast.warning(
          "Case cleared. Withdrawals stay locked until an owner or admin approves KYC.",
        );
      } else {
        toast.success(
          result.withdrawalRelease === "released"
            ? "Case cleared — withdrawals unlocked"
            : `Marked ${REVIEW_STATUS_LABELS[next].toLowerCase()}`,
        );
      }
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
      <div className="space-y-3">
        <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Review workflow
        </Label>
        <Textarea
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          rows={3}
          placeholder="Record your conclusion before clearing or flagging."
          className="text-xs"
        />
        <div className="grid grid-cols-2 gap-2">
          {REVIEW_STATUSES.map((value) => {
            const needsConclusion =
              isTerminalTarget(value) && trimmedResolution.length === 0;
            return (
              <button
                key={value}
                type="button"
                disabled={pending !== null || value === status || needsConclusion}
                title={
                  needsConclusion ? "Write your conclusion first" : undefined
                }
                onClick={() => void changeStatus(value)}
                className={cn(
                  "min-h-9 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                  value === status
                    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
                    : value === "flagged"
                      ? "border-rose-500/30 bg-rose-500/5 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                      : value === "cleared"
                        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                        : value === "in_review" && status === "open"
                          ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                          : "border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground",
                )}
              >
                {pending === `status-${value}`
                  ? "…"
                  : value === "in_review" && status === "open"
                    ? "Start review"
                    : value === "cleared"
                      ? "Clear account"
                      : value === "flagged"
                        ? "Flag account"
                        : value === "open"
                          ? "Reopen"
                          : REVIEW_STATUS_LABELS[value]}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Clear and Flag require a conclusion. Clearing also unlocks crypto and
          item withdrawals — unless the account is awaiting KYC, which only an
          owner or admin can approve. Reopening withdraws the previous verdict
          but keeps the append-only trail — it does not re-lock.
        </p>
      </div>

      <div className="space-y-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          disabled={
            pending !== null || status === "cleared" || status === "flagged"
          }
          onClick={() =>
            run(
              "postpone",
              () =>
                postponeReview({
                  reviewId,
                  idempotencyKey: crypto.randomUUID(),
                }),
              "Review postponed for 2.5 hours",
            )
          }
        >
          <Clock3 className="mr-2 size-4" />
          {pending === "postpone" ? "Postponing…" : "Postpone 2.5 hours"}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Removes this case from active tabs and suppresses reminders until it
          is due.
        </p>
      </div>

      {/* ── Assignment ─────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label
          htmlFor="case-assign-select"
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
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
          className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
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
