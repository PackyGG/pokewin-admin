"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { approveCreatorSocial, rejectCreatorSocial } from "./actions";

/**
 * Preset rejection reasons — clicking one rejects immediately with that exact
 * string as the action's `reason`, so the audit metadata stays queryable
 * (`metadata->>'reason' = 'Broken link'`) instead of free-prose-only. "Other"
 * opens a free-text field.
 */
const REJECT_REASON_PRESETS = [
  "Not the creator's account",
  "Broken link",
  "Duplicate",
] as const;

/**
 * Per-row approve/reject controls.
 *
 * Optimistic: the row's removal is owned by the parent list — `onRemove` hides
 * the row the moment an action fires, `onRestore` brings it back if the server
 * action fails (with an error toast). Approve and reject each have their OWN
 * in-flight spinner (the old version only spun on approve), and both buttons
 * lock while either is in flight so a row can't be double-actioned.
 */
export function SocialReviewActions({
  socialId,
  onRemove,
  onRestore,
}: {
  socialId: string;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [otherReason, setOtherReason] = useState("");
  const busy = approving || rejecting;

  const onApprove = async () => {
    setApproving(true);
    onRemove(socialId);
    try {
      await approveCreatorSocial(socialId);
      toast.success("Approved");
    } catch (err) {
      onRestore(socialId);
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setApproving(false);
    }
  };

  const onReject = async (reason: string | undefined) => {
    setRejecting(true);
    setRejectOpen(false);
    onRemove(socialId);
    try {
      await rejectCreatorSocial(socialId, { reason });
      toast.success("Rejected");
      setOtherReason("");
    } catch (err) {
      onRestore(socialId);
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setRejecting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="default" onClick={onApprove} disabled={busy}>
        {approving ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}
        Approve
      </Button>
      <Popover open={rejectOpen} onOpenChange={setRejectOpen}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="outline" disabled={busy}>
              {rejecting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <X className="size-3.5" />
              )}
              Reject
            </Button>
          }
        />
        <PopoverContent align="end" className="w-64 p-2">
          <RejectReasonPicker
            otherReason={otherReason}
            onOtherReasonChange={setOtherReason}
            onPick={onReject}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Shared reject-reason body (presets + "Other" free text) — used by the
 * per-row popover above and the bulk bar's popover in `queue-list.tsx`.
 */
export function RejectReasonPicker({
  otherReason,
  onOtherReasonChange,
  onPick,
}: {
  otherReason: string;
  onOtherReasonChange: (value: string) => void;
  onPick: (reason: string | undefined) => void;
}) {
  const [showOther, setShowOther] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 py-0.5 text-[11px] font-semibold text-muted-foreground">
        Reject with reason
      </p>
      {REJECT_REASON_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          onClick={() => onPick(preset)}
          className="rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-muted"
        >
          {preset}
        </button>
      ))}
      {showOther ? (
        <div className="flex items-center gap-1.5 p-1">
          <input
            type="text"
            autoFocus
            value={otherReason}
            onChange={(e) => onOtherReasonChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onPick(otherReason.trim() || undefined);
              }
            }}
            placeholder="Reason (optional)"
            maxLength={500}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus:border-foreground/40"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPick(otherReason.trim() || undefined)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowOther(true)}
          className="rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Other…
        </button>
      )}
    </div>
  );
}
