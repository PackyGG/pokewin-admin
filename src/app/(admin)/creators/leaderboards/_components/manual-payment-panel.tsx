"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const [paid, setPaid] = useState(initialPaidManually);
  const [note, setNote] = useState(initialPayoutNote ?? "");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const persistedNote = initialPayoutNote ?? "";
  const trimmedNote = note.trim();
  const trimmedPersisted = persistedNote.trim();
  const dirty =
    paid !== initialPaidManually ||
    // Only the on-state note matters — when toggle is off the backend
    // forces note to null regardless, so changes are irrelevant.
    (paid && trimmedNote !== trimmedPersisted);

  function reset() {
    setPaid(initialPaidManually);
    setNote(initialPayoutNote ?? "");
  }

  function handleToggle(next: boolean) {
    setPaid(next);
    // Clear the note in the editor when toggling off so it's clear the
    // value won't persist; persisted note still shows on next render if
    // the user cancels.
    if (!next) setNote("");
  }

  function handleSave() {
    startTransition(async () => {
      const r = await setLeaderboardManualPayment(leaderboardId, {
        paid_manually: paid,
        payout_note: paid ? (trimmedNote.length === 0 ? null : trimmedNote) : null,
      });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success(paid ? "Marked as paid manually" : "Manual payment cleared");
      router.refresh();
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
