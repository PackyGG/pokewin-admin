"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import { Textarea } from "@/components/ui/textarea";
import { requireAccountKyc } from "../kyc/actions";

export function RequireKycAction({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [credential, setCredential] = useState("");
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    startTransition(async () => {
      const result = await requireAccountKyc({
        account: userId,
        reason,
        credential,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Deposits, withdrawals and tips are locked for ${displayName}. KYC is now required.`,
      );
      setOpen(false);
      setReason("");
      setCredential("");
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
            className="h-9 min-w-24 px-3"
          />
        }
      >
        <BadgeCheck className="size-3.5" />
        Require KYC
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Require KYC for {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This locks fiat deposits and all withdrawals, locks tip rewards,
            and then requires KYC for this account. A Sumsub result never
            unlocks the account automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`kyc-reason-${userId}`}>Reason</Label>
          <Textarea
            id={`kyc-reason-${userId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Why does this account need KYC?"
            disabled={isPending}
          />
          <p className="text-right text-[11px] text-muted-foreground">
            {reason.trim().length}/500
          </p>
        </div>
        <StepUpField value={credential} onChange={setCredential} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending || reason.trim().length < 3 || !credential.trim()}
            onClick={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {isPending ? "Applying…" : "Require KYC"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
