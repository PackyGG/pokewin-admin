"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldX } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { reviewAccountKyc } from "../actions";
import { StepUpField } from "@/components/step-up-field";

export function ReviewKycControls({
  userId,
  label,
  verificationCycle,
}: {
  userId: string;
  label: string;
  verificationCycle: number;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<"safe" | "rejected">("safe");
  const [isPending, startTransition] = useTransition();
  const [credential, setCredential] = useState("");

  function submit(): void {
    startTransition(async () => {
      const result = await reviewAccountKyc({
        userId,
        decision,
        expectedCycle: verificationCycle,
        credential,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        decision === "safe"
          ? "Account marked safe. Withdrawals are unlocked."
          : "Account rejected. Withdrawals stay locked.",
      );
      router.refresh();
    });
  }

  return (
    <AlertDialog>
      <div className="flex flex-wrap gap-1.5">
        <AlertDialogTrigger
          render={
            <Button
              size="xs"
              disabled={isPending}
              onClick={() => setDecision("safe")}
            />
          }
        >
          <CheckCircle2 className="mr-1.5 size-3.5" />
          Mark safe
        </AlertDialogTrigger>
        <AlertDialogTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              disabled={isPending}
              onClick={() => setDecision("rejected")}
            />
          }
        >
          <ShieldX className="mr-1.5 size-3.5" />
          Reject
        </AlertDialogTrigger>
      </div>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {decision === "safe" ? "Mark this cycle safe?" : "Reject this cycle?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {decision === "safe"
              ? `This unlocks withdrawals for ${label}. Only continue after reviewing the current Sumsub result and account evidence.`
              : `This keeps withdrawals locked for ${label}. The decision applies only to verification cycle ${verificationCycle}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <StepUpField
          value={credential}
          onChange={setCredential}
          disabled={isPending}
          label="Fresh TOTP or passkey"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={isPending || !credential}
            className={
              decision === "rejected"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
          >
            {isPending
              ? "Applying…"
              : decision === "safe"
                ? "Mark safe"
                : "Reject cycle"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
