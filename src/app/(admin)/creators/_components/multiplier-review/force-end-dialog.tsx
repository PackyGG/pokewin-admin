"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, PowerOff } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { forceEndMultiplierStream } from "../../multiplier-actions";

type Props = {
  deal: MultiplierDealResponse;
  trigger: React.ReactNode;
  onSuccess?: () => void;
};

/**
 * Force-end dialog — admin yanks a live multiplier stream to the review
 * queue without the creator's involvement.
 *
 * Behavior:
 *   - VOD requirement is bypassed (creator didn't supply one).
 *   - Inventory + non-payout vouchers are still auto-liquidated.
 *   - Fraud detector runs as usual; MISSING_KICK_VOD will fire (along
 *     with any activity-floor flags) so the deal lands in `flagged`.
 *   - Settlement still needs an approve/reject decision afterward.
 *
 * The destructive variant of the button is justified: force-ending mid-
 * stream might interrupt a creator's session unexpectedly.
 */
export function MultiplierForceEndDialog({
  deal,
  trigger,
  onSuccess,
}: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function reset() {
    setReason("");
  }

  function submit() {
    startTransition(async () => {
      try {
        await forceEndMultiplierStream(deal.user_id, deal.id, {
          reason: reason.trim() || undefined,
        });
        toast.success("Multiplier stream force-ended");
        setOpen(false);
        reset();
        onSuccess?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to force-end stream",
        );
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PowerOff className="size-5 text-rose-500" />
            Force-End Multiplier Stream
          </DialogTitle>
          <DialogDescription>
            Yank this live stream to the review queue. The Kick VOD
            requirement is bypassed; the deal will land in{" "}
            <strong>flagged</strong> with MISSING_KICK_VOD on top of any
            activity flags. Settlement still requires a separate
            approve/reject decision.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="force-end-reason">Reason (optional)</Label>
            <Textarea
              id="force-end-reason"
              placeholder="e.g. unresponsive creator, suspected disconnect, manual review trigger"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose
            render={<Button variant="ghost" disabled={isPending} />}
          >
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Force-ending…
              </>
            ) : (
              <>Force-end stream</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
