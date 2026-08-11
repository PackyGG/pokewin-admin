"use client";

import { useState, useTransition } from "react";
import { BadgeDollarSign, Loader2 } from "lucide-react";
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
import { StepUpField } from "@/components/step-up-field";
import { allowFutureFiatAutoCreditAction } from "./auto-credit-actions";

export function AllowFiatAutoCreditAction({
  intentId,
  userId,
  displayName,
  cleanDeposits,
}: {
  intentId: string;
  userId: string;
  displayName: string;
  cleanDeposits: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stepUpCredential, setStepUpCredential] = useState("");
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    startTransition(async () => {
      const result = await allowFutureFiatAutoCreditAction({
        intentId,
        userId,
        stepUpCredential,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Future verified Fiat deposits can auto-credit for ${displayName}`);
      setOpen(false);
      setStepUpCredential("");
      router.refresh();
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && setOpen(next)}>
      <AlertDialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="h-12 w-28 border-blue-500/30 px-3 text-blue-700 hover:bg-blue-500/10 dark:text-blue-300"
          />
        }
      >
        <BadgeDollarSign className="size-4" />
        <span className="text-center leading-tight">Allow future auto credit</span>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Allow future automatic Fiat credit?</AlertDialogTitle>
          <AlertDialogDescription>
            {displayName} has {cleanDeposits} completed Fiat deposits across at
            least 14 days, no refund or dispute history, no active money locks,
            and a clean current assessment. This affects future verified
            deposits only; it does not approve the current deposit and safety
            checks still apply.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <StepUpField
          value={stepUpCredential}
          onChange={setStepUpCredential}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button onClick={submit} disabled={isPending || !stepUpCredential.trim()}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            {isPending ? "Enabling…" : "Allow future auto credit"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
