"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { cancelLeaderboard } from "../actions";

/**
 * Small inline cancel button for affiliate leaderboard rows. Shipped
 * for the LeaderboardsCard on /creators/[userId] so admins can cancel
 * a creator's leaderboard without bouncing to /creators/leaderboards.
 *
 * "Cancel" in this domain means: lock the leaderboard, refund the
 * creator's funded prize, and stop accepting new standings updates.
 * It's the only delete-shaped operation the backend exposes — there
 * is no hard-delete endpoint by design (the audit trail must
 * survive). Existing rankings stay visible after cancellation; only
 * new wager activity stops counting.
 *
 * Disabled when the leaderboard is already cancelled. Auth check
 * happens server-side in cancelLeaderboard via requireCapability —
 * unauthorised admins still see the button but get a friendly toast
 * error on click.
 */
export function CancelLeaderboardButton({
  id,
  title,
  disabled,
}: {
  id: string;
  title: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      const result = await cancelLeaderboard(id);
      if (!result.success) {
        toast.error(result.error ?? "Failed to cancel leaderboard");
        return;
      }
      toast.success("Leaderboard cancelled and refunded");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            size="icon"
            variant="ghost"
            disabled={disabled}
            // Stop the parent <Link>'s click from firing — without
            // this the row's navigation hijacks the dialog open.
            onClick={(e) => e.stopPropagation()}
            // Stop bubbling on key activation too (Space/Enter open
            // the dialog and shouldn't also navigate).
            onKeyDown={(e) => e.stopPropagation()}
            className="size-7 shrink-0 text-muted-foreground hover:text-rose-500"
            title={
              disabled
                ? "Leaderboard already cancelled"
                : "Cancel leaderboard"
            }
            aria-label={`Cancel leaderboard "${title}"`}
          />
        }
      >
        <Trash2 className="size-3.5" />
      </AlertDialogTrigger>
      <AlertDialogContent
        // Same — once the dialog is open we don't want clicks inside
        // to bubble back to the parent row Link.
        onClick={(e) => e.stopPropagation()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel leaderboard?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Cancel{" "}
              <span className="font-semibold text-foreground">
                &quot;{title}&quot;
              </span>
              ?
            </span>
            <span className="block">
              This <strong>refunds the creator&apos;s funded prize</strong> and
              stops accepting new standings updates. Existing rankings stay
              visible for record-keeping. The action is logged in the audit
              trail and cannot be undone — start a new leaderboard if you need
              one.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-500/90"
          >
            {pending ? "Cancelling…" : "Cancel & refund"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
