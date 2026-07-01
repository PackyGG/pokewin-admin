"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { CircleCheck, CircleDashed } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { setLeaderboardManualPayment } from "../actions";

/**
 * Toggle the admin-side "paid manually" flag and an optional payout note.
 * Edits are local until Save — Cancel reverts the editor to the persisted
 * state. Toggling OFF clears the note field locally too, matching the
 * backend's behavior of dropping payout_note whenever paid_manually=false.
 *
 * Permission gating (capability check) happens server-side; the panel
 * relies on toast.error to surface "not allowed" if the action rejects.
 *
 * Scroll-fix: on Save the panel updates OPTIMISTICALLY in place with NO
 * `router.refresh()` — the detail page never re-renders / loses scroll
 * position. A local "saved baseline" tracks the persisted state so Cancel
 * and the dirty-check stay correct without a route refresh; the server
 * stays source of truth via the `revalidateTag("creator-leaderboards")` +
 * `revalidatePath` the action fires. A failed save rolls the baseline back
 * and toasts the error.
 */
export function ManualPaymentPanel({
  leaderboardId,
  initialPaidManually,
  initialPayoutNote,
}: {
  leaderboardId: string;
  initialPaidManually: boolean;
  initialPayoutNote: string | null;
}) {
  // Persisted server-truth baseline (optimistic). Seeded from props; re-synced
  // when a real revalidation streams fresh props in (unless a save is in
  // flight, so the in-flight optimistic value is never clobbered).
  const [savedPaid, setSavedPaid] = useState(initialPaidManually);
  const [savedNote, setSavedNote] = useState(initialPayoutNote ?? "");
  const [paid, setPaid] = useState(initialPaidManually);
  const [note, setNote] = useState(initialPayoutNote ?? "");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (isPending) return;
    setSavedPaid(initialPaidManually);
    setSavedNote(initialPayoutNote ?? "");
  }, [initialPaidManually, initialPayoutNote, isPending]);

  const trimmedNote = note.trim();
  const trimmedSaved = savedNote.trim();
  const dirty =
    paid !== savedPaid ||
    // Only the on-state note matters — when toggle is off the backend
    // forces note to null regardless, so changes are irrelevant.
    (paid && trimmedNote !== trimmedSaved);

  function reset() {
    setPaid(savedPaid);
    setNote(savedNote);
  }

  function handleToggle(next: boolean) {
    setPaid(next);
    // Clear the note in the editor when toggling off so it's clear the
    // value won't persist; persisted note still shows on next render if
    // the user cancels.
    if (!next) setNote("");
  }

  function handleSave() {
    const nextPaid = paid;
    const nextNote = nextPaid ? (trimmedNote.length === 0 ? null : trimmedNote) : null;
    const prevPaid = savedPaid;
    const prevNote = savedNote;
    // Optimistic commit — the current editor state becomes the new baseline
    // so `dirty` clears and Cancel resets to it, all without a route refresh.
    setSavedPaid(nextPaid);
    setSavedNote(nextNote ?? "");
    startTransition(async () => {
      const r = await setLeaderboardManualPayment(leaderboardId, {
        paid_manually: nextPaid,
        payout_note: nextNote,
      });
      if (!r.success) {
        // Roll the baseline back to the previous persisted state.
        setSavedPaid(prevPaid);
        setSavedNote(prevNote);
        toast.error(r.error);
        return;
      }
      toast.success(nextPaid ? "Marked as paid manually" : "Manual payment cleared");
    });
  }

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Manual payout
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Mark this leaderboard as paid off-platform (e.g. PayPal / wire).
            Annotation only — no balances are moved.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {paid ? (
            <CircleCheck className="size-4 text-emerald-500" />
          ) : (
            <CircleDashed className="size-4 text-muted-foreground" />
          )}
          <Switch
            checked={paid}
            onCheckedChange={handleToggle}
            disabled={isPending}
          />
        </div>
      </div>

      {paid && (
        <div className="space-y-2">
          <label
            htmlFor={`manual-payout-note-${leaderboardId}`}
            className="text-xs font-medium text-muted-foreground"
          >
            Note <span className="text-muted-foreground/60">(optional)</span>
          </label>
          <Textarea
            id={`manual-payout-note-${leaderboardId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Paid via PayPal 2026-05-12, tx PP-XYZ"
            rows={3}
            maxLength={2000}
            disabled={isPending}
            className="text-sm"
          />
          <div className="flex justify-end text-[10px] text-muted-foreground tabular-nums">
            {note.length}/2000
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={isPending || !dirty}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isPending || !dirty}
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
