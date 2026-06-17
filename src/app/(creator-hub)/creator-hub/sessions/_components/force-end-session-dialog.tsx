"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, OctagonX } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { forceEndCreatorSession } from "../../../../(admin)/creators/backend-actions";

/**
 * Creator Hub — All Sessions: force-end the current ACTIVE session for one
 * creator. A small destructive button + confirmation dialog with an OPTIONAL
 * reason field. Calls the existing per-creator
 * {@link forceEndCreatorSession} server action (reused, never re-implemented)
 * with `userId = row.user_id`, `sessionId = row.id`; on success it refreshes
 * the route so the feed reflects the ended session.
 *
 * Client→client only (this is mounted by the client table) — no function props
 * cross the RSC boundary.
 */
export function ForceEndSessionButton({
  userId,
  sessionId,
}: {
  userId: string;
  sessionId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      try {
        const trimmed = reason.trim();
        await forceEndCreatorSession(
          userId,
          sessionId,
          trimmed ? { reason: trimmed } : {},
        );
        toast.success("Session force-ended");
        setOpen(false);
        setReason("");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to end session",
        );
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
        onClick={() => setOpen(true)}
      >
        <OctagonX className="mr-1.5 size-3.5" />
        Force end
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force-end this session?</AlertDialogTitle>
            <AlertDialogDescription>
              The session will end exactly as if the creator clicked end
              themselves: inventory liquidated, vouchers redeemed, fill balance
              converted at the locked rate, and a payout voucher issued. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-1.5">
            <label
              htmlFor={`force-end-reason-${sessionId}`}
              className="text-xs font-medium text-muted-foreground"
            >
              Reason <span className="font-normal">(optional)</span>
            </label>
            <Textarea
              id={`force-end-reason-${sessionId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you ending this session? (kept in the audit log)"
              disabled={isPending}
              className="min-h-16"
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={handleConfirm}
              className={cn("bg-rose-600 text-white hover:bg-rose-700")}
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                  Ending...
                </>
              ) : (
                "Force-end"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
