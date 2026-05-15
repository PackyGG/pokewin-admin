"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { cancelMultiplierDeal } from "../../multiplier-actions";
import { formatStringUsd } from "./shared";

type Props = {
  deal: MultiplierDealResponse;
  trigger: React.ReactNode;
  onSuccess?: () => void;
};

/**
 * Cancel dialog — voids a pending_deposit (offer never accepted) or
 * funded (deposit locked, stream never started) deal.
 *
 * For pending_deposit there's no money movement — just status flip.
 * For funded the deposit is automatically refunded in full (admin
 * punitive forfeit is NOT available here — that's a reject-only path).
 *
 * AlertDialog rather than Dialog because cancel is destructive (offer
 * disappears) and we want a confirm-before-action surface.
 */
export function MultiplierCancelDialog({ deal, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const willRefundDeposit =
    deal.status === "funded" &&
    deal.user_funding_usd !== null &&
    Number(deal.user_funding_usd) > 0;

  function submit() {
    startTransition(async () => {
      try {
        await cancelMultiplierDeal(deal.user_id, deal.id, {
          reason: reason.trim() || undefined,
        });
        toast.success("Multiplier deal cancelled");
        setOpen(false);
        setReason("");
        onSuccess?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to cancel deal",
        );
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setReason("");
      }}
    >
      <AlertDialogTrigger render={trigger as React.ReactElement} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="size-5 text-rose-500" />
            Cancel Multiplier Deal
          </AlertDialogTitle>
          <AlertDialogDescription>
            {willRefundDeposit ? (
              <>
                The creator&apos;s locked deposit of{" "}
                <strong>
                  {formatStringUsd(deal.user_funding_usd)}
                </strong>{" "}
                will be returned to their available balance. The deal will
                be marked cancelled.
              </>
            ) : (
              <>
                No money has been locked yet. The offer will be marked
                cancelled and removed from the creator&apos;s queue.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="cancel-reason">Reason (optional)</Label>
          <Textarea
            id="cancel-reason"
            placeholder="e.g. wrong contract terms, creator changed their mind"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              submit();
            }}
            disabled={isPending}
            className="bg-rose-500 text-white hover:bg-rose-600"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Cancelling…
              </>
            ) : (
              <>Cancel deal</>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
