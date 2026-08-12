"use client";

import { useState, useTransition } from "react";
import { Ban, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { StepUpField } from "@/components/step-up-field";
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
  const [credential, setCredential] = useState("");
  const [pending, startTransition] = useTransition();
  const confirming = decision === "confirm";
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setCredential("");
      }}
    >
      <AlertDialogTrigger render={
        <Button variant={confirming ? "destructive" : "outline"} size="sm">
          {confirming ? <Ban /> : <XCircle />}
          {confirming ? "Confirm abuse & lock rewards" : "Dismiss finding"}
        </Button>
      } />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirming ? "Lock Rain, tips, and sponsored battles?" : "Dismiss this finding?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirming
              ? "This disables future Rain participation, tips, and sponsored battles. It also removes remaining Rain-attributable general-bonus funds, capped by both the reviewed net Rain and the live available balance. The balance can never go below $0. Any active rain already joined still settles normally."
              : "The account will remain unchanged and will not be detected again for 30 days."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!confirming ? (
          <Textarea
            aria-label="Review note"
            placeholder="Why this looks legitimate…"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
          />
        ) : null}
        {confirming ? (
          <StepUpField value={credential} onChange={setCredential} />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={
              pending ||
              (!confirming && reason.trim().length < 3) ||
              (confirming && !credential.trim())
            }
            onClick={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await decideRewardAbuseReview({
                  reviewId,
                  decision,
                  reason: confirming ? undefined : reason,
                  credential: confirming ? credential.trim() : undefined,
                });
                if (!result.ok) {
                  toast.error(result.message);
                  return;
                }
                toast.success(
                  confirming
                    ? `Abuse confirmed, rewards locked, and $${result.rainFundsRemovedUsd.toFixed(2)} removed`
                    : "Finding dismissed — no account changes made",
                );
                setCredential("");
                setOpen(false);
                router.refresh();
              });
            }}
          >
            {pending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            {confirming ? "Confirm and lock rewards" : "Dismiss finding"}
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
