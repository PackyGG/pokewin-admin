"use client";

import { useState, useTransition } from "react";
import { Ban, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { decideRewardAbuseReview } from "./actions";

function DecisionDialog({
  reviewId,
  decision,
}: {
  reviewId: string;
  decision: "confirm" | "dismiss";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const confirming = decision === "confirm";
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={
        <Button variant={confirming ? "destructive" : "outline"} size="sm">
          {confirming ? <Ban /> : <XCircle />}
          {confirming ? "Confirm abuse & disable Rain" : "Dismiss finding"}
        </Button>
      } />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirming ? "Disable Rain rewards for this account?" : "Dismiss this finding?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirming
              ? "This staff decision adds only the Rain reward lock, blocking future joins and tips. Any active rain already joined still settles normally."
              : "The account will remain unchanged and will not be detected again for 30 days."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          aria-label="Review note"
          placeholder={confirming ? "Why this behavior is abusive…" : "Why this looks legitimate…"}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={4}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || reason.trim().length < 3}
            onClick={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await decideRewardAbuseReview({ reviewId, decision, reason });
                if (!result.ok) {
                  toast.error(result.message);
                  return;
                }
                toast.success(
                  confirming
                    ? "Abuse confirmed and Rain rewards disabled"
                    : "Finding dismissed — no account changes made",
                );
                setOpen(false);
                router.refresh();
              });
            }}
          >
            {pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            {confirming ? "Confirm and disable Rain" : "Dismiss finding"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RewardAbuseReviewActions({ reviewId }: { reviewId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <DecisionDialog reviewId={reviewId} decision="confirm" />
      <DecisionDialog reviewId={reviewId} decision="dismiss" />
    </div>
  );
}
