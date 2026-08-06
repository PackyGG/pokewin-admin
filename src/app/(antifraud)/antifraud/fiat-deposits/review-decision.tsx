"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import { Textarea } from "@/components/ui/textarea";
import { decideFiatDepositAction } from "./actions";

export function FiatDepositReviewDecision({
  intentId,
  displayName,
  amount,
  status,
}: {
  intentId: string;
  displayName: string;
  amount: string;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [reason, setReason] = useState("");
  const [stepUpCredential, setStepUpCredential] = useState("");
  const [isPending, startTransition] = useTransition();
  const canApprove = status === "review";
  const canReject = status === "review" || status === "refund_failed";

  const launch = (nextDecision: "approve" | "reject") => {
    setDecision(nextDecision);
    setReason("");
    setStepUpCredential("");
    setOpen(true);
  };

  const submit = () => {
    startTransition(async () => {
      const result = await decideFiatDepositAction({
        intentId,
        decision,
        reason,
        stepUpCredential,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        decision === "approve"
          ? `${amount} approved for ${displayName}`
          : `Refund started for ${displayName}`,
      );
      setOpen(false);
      setStepUpCredential("");
      router.refresh();
    });
  };

  if (!canApprove && !canReject) {
    return (
      <span className="text-xs text-muted-foreground">
        Decision processing
      </span>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && setOpen(next)}>
      <div className="flex flex-wrap gap-2">
        {canApprove && (
          <AlertDialogTrigger
            render={
              <Button
                size="sm"
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={() => launch("approve")}
              />
            }
          >
            <CheckCircle2 className="size-4" />
            Approve credit
          </AlertDialogTrigger>
        )}
        {canReject && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => launch("reject")}
          >
            {status === "refund_failed" ? (
              <RotateCcw className="size-4" />
            ) : (
              <XCircle className="size-4" />
            )}
            {status === "refund_failed" ? "Retry refund" : "Reject & refund"}
          </Button>
        )}
      </div>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {decision === "approve"
              ? `Approve ${amount} Fiat credit?`
              : `Reject and refund ${amount}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {decision === "approve"
              ? `This credits ${displayName}'s balance. The backend prevents duplicate approval if another admin acts first.`
              : `This does not credit ${displayName}. It asks Whop to refund the authorized payment instead.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`fiat-decision-reason-${intentId}`}>Decision reason</Label>
          <Textarea
            id={`fiat-decision-reason-${intentId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder={
              decision === "approve"
                ? "Why is this payment safe to credit?"
                : "Why should this payment be rejected?"
            }
            disabled={isPending}
          />
          <p className="text-right text-[11px] text-muted-foreground">
            {reason.trim().length}/500
          </p>
        </div>
        <StepUpField
          value={stepUpCredential}
          onChange={setStepUpCredential}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            variant={decision === "reject" ? "destructive" : "default"}
            onClick={submit}
            disabled={
              isPending ||
              reason.trim().length < 3 ||
              !stepUpCredential.trim()
            }
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            {isPending
              ? "Submitting..."
              : decision === "approve"
                ? "Approve balance credit"
                : "Reject and refund"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
