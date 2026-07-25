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
import {
  REVIEW_SEVERITIES,
  REVIEW_SEVERITY_LABELS,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
} from "@/lib/antifraud/constants";
import {
  addReviewNote,
  assignReview,
  updateReviewSeverity,
  updateReviewStatus,
} from "../actions";

/**
 * The working controls on a case: move its status, re-grade severity, hand it
 * to someone (or take it), and add notes.
 *
 * Everything routes through the server actions in `../actions.ts`, which
 * re-verify workspace access, write an append-only note describing the change,
 * and mirror the important ones into `admin_audit_events`. Nothing here can
 * touch the player's actual account — that stays on the main dashboard.
 */

export function CaseControls({
  reviewId,
  status,
  severity,
  assignedTo,
  viewerId,
  analysts,
}: {
  reviewId: string;
  status: string;
  severity: string;
  assignedTo: string | null;
  viewerId: string;
  analysts: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [resolution, setResolution] = React.useState("");
  const [note, setNote] = React.useState("");

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

  return (
    <div className="space-y-5 rounded-xl border border-border/60 bg-card p-4">
      {/* ── Status ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          Status
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {REVIEW_STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              disabled={pending !== null || value === status}
              onClick={() =>
                run(
                  `status-${value}`,
                  () =>
                    updateReviewStatus({
                      reviewId,
                      status: value,
                      resolution: isTerminalTarget(value)
                        ? resolution.trim()
                        : "",
                    }),
                  `Marked ${REVIEW_STATUS_LABELS[value].toLowerCase()}`,
                )
              }
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
          ))}
        </div>
        <Textarea
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          rows={2}
          placeholder="Optional: what did you conclude? (saved with Cleared / Flagged)"
          className="text-xs"
        />
      </div>

      {/* ── Severity ───────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label
          htmlFor="case-severity-select"
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Severity
        </Label>
        <Select
          value={severity}
          onValueChange={(v) => {
            if (!v || v === severity) return;
            void run(
              "severity",
              () => updateReviewSeverity({ reviewId, severity: v }),
              "Severity updated",
            );
          }}
        >
          <SelectTrigger id="case-severity-select" disabled={pending !== null}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REVIEW_SEVERITIES.map((value) => (
              <SelectItem key={value} value={value}>
                {REVIEW_SEVERITY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
