"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatCurrency } from "@/lib/utils/format";

import { HubNotice } from "../../_components/hub-notice";
import {
  planCreatorRewardProgramRemoval,
  removeCreatorRewardProgram,
  type ProgramRemovalPlan,
} from "../actions";

/**
 * Confirm removing a program — with the actual consequence, not a generic
 * warning.
 *
 * Whether this deletes or archives is decided by the DATA (claims are payout
 * history behind an ON DELETE RESTRICT), so the plan is fetched when the dialog
 * opens and the copy, the button and the `expectedMode` handed back to the
 * server all follow from it. Confirming with a stale mode is refused server-side
 * rather than silently upgraded.
 */
export function ProgramRemoveDialog({
  programId,
  programName,
  open,
  onOpenChange,
}: {
  programId: string;
  programName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [plan, setPlan] = useState<ProgramRemovalPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    void planCreatorRewardProgramRemoval({ programId }).then((res) => {
      if (cancelled) return;
      if (res.success) setPlan(res.data);
      else setPlanError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open, programId]);

  const blockedByPending = plan != null && plan.pendingClaims > 0;

  function confirm() {
    if (!plan) return;
    startTransition(async () => {
      const res = await removeCreatorRewardProgram({
        programId,
        expectedMode: plan.mode,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.data.mode === "delete" ? "Program deleted" : "Program archived",
      );
      onOpenChange(false);
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {plan?.mode === "archive"
              ? `Archive ${programName}?`
              : `Delete ${programName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {planError
              ? planError
              : !plan
                ? "Checking what this program has already paid out…"
                : plan.mode === "delete"
                  ? "Permanently delete — this program has never produced a claim, so nothing is lost."
                  : `This program can't be deleted: ${plan.totalClaims} claim${plan.totalClaims === 1 ? "" : "s"} and ${formatCurrency(plan.paidOutUsd)} paid out are payout history. It will be archived instead — hidden from the list, never active again, and dropped from the bot's offers. You can restore it later.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {plan && plan.mode === "archive" && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              Paid out{" "}
              {/* House-POV: money already given to players. */}
              <span className="tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(plan.paidOutUsd)}
              </span>{" "}
              over {plan.approvedClaims} approved claim
              {plan.approvedClaims === 1 ? "" : "s"}
            </div>
          </div>
        )}

        {plan && plan.openOffers > 0 && (
          <HubNotice tone="amber">
            {plan.openOffers} open Discord offer
            {plan.openOffers === 1 ? "" : "s"} will stop being claimable.
          </HubNotice>
        )}

        {blockedByPending && (
          <HubNotice tone="rose">
            {plan.pendingClaims} claim{plan.pendingClaims === 1 ? " is" : "s are"}{" "}
            still awaiting review. Approve or reject{" "}
            {plan.pendingClaims === 1 ? "it" : "them"} first — removing the
            program now would strand{" "}
            {plan.pendingClaims === 1 ? "it" : "them"} in the queue.
          </HubNotice>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={isPending || plan == null || blockedByPending}
            className="bg-rose-600 text-white hover:bg-rose-700"
          >
            {isPending
              ? "Removing…"
              : plan?.mode === "archive"
                ? "Archive program"
                : "Delete program"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
