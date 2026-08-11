"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
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
}: {
  intentId: string;
  displayName: string;
  amount: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<"approve" | "decline">("approve");
  const [reason, setReason] = useState("");
  const [stepUpCredential, setStepUpCredential] = useState("");
  const [isPending, startTransition] = useTransition();

  const launch = (nextDecision: "approve" | "decline") => {
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
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        decision === "approve"
          ? `${amount} approved for ${displayName}`
          : `${displayName}'s deposit was declined and money movement was locked`,
      );
      setOpen(false);
      setStepUpCredential("");
      router.refresh();
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && setOpen(next)}>
      <div className="flex flex-wrap gap-2">
        <AlertDialogTrigger
          render={
            <Button
              size="sm"
              className="h-11 w-28 px-3 bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => launch("approve")}
            />
          }
        >
          <CheckCircle2 className="size-4" />
          Approve
        </AlertDialogTrigger>
        <Button
          size="sm"
          variant="destructive"
          className="h-11 w-28 px-3"
          onClick={() => launch("decline")}
        >
          <XCircle className="size-4" />
          Decline
        </Button>
      </div>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {decision === "approve"
              ? `Approve ${amount} Fiat credit?`
              : `Decline ${amount} Fiat credit?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {decision === "approve"
              ? `This credits only this deposit for ${displayName}. Future Fiat deposits will still require their own review.`
              : `This does not refund the payment. It locks Fiat deposits and all withdrawals, then sends the deposit to Admin for a refund and/or ban decision.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {decision === "decline" && (
          <div className="space-y-2">
            <Label htmlFor={`fiat-decision-reason-${intentId}`}>
              Decision reason
            </Label>
            <Textarea
              id={`fiat-decision-reason-${intentId}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              placeholder="Why should this payment be declined?"
              disabled={isPending}
            />
            <p className="text-right text-[11px] text-muted-foreground">
              {reason.trim().length}/500
            </p>
          </div>
        )}
        <StepUpField
          value={stepUpCredential}
          onChange={setStepUpCredential}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            variant={decision === "decline" ? "destructive" : "default"}
            onClick={submit}
            disabled={
              isPending ||
              (decision === "decline" && reason.trim().length < 3) ||
              !stepUpCredential.trim()
            }
          >
            {isPending && <Loader2 className="size-4 animate-spin" />}
            {isPending
              ? "Submitting..."
              : decision === "approve"
                ? "Approve balance credit"
                : "Decline and lock account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
