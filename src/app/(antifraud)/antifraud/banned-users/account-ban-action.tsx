"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { StepUpField } from "@/components/step-up-field";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clientActionError } from "@/lib/errors/client-action-error";
import { mutateBannedUser } from "./actions";

export function AccountBanAction({
  userId,
  account,
  action,
}: {
  userId: string;
  account: string;
  action: "ban" | "unban";
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [credential, setCredential] = useState("");
  const [pending, startTransition] = useTransition();
  const isBan = action === "ban";
  const Icon = isBan ? Ban : ShieldCheck;

  function submit() {
    startTransition(async () => {
      try {
        await mutateBannedUser({
          userId,
          action,
          reason: reason.trim(),
          credential,
          confirmed: true,
          idempotencyKey: crypto.randomUUID(),
        });
        setReason("");
        setCredential("");
        toast.success(isBan ? "Account banned." : "Account unbanned.");
        router.refresh();
      } catch (error) {
        toast.error(clientActionError(error, "The action failed."));
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={isBan ? "destructive" : "outline"}
            disabled={pending}
          />
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
        {isBan ? "Ban" : "Unban"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isBan ? "Ban" : "Unban"} {account}?</AlertDialogTitle>
          <AlertDialogDescription>
            This changes the live account through the established moderation
            boundary and records the reason in the Antifraud audit.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`${action}-${userId}-reason`}>Reason</Label>
          <Input
            id={`${action}-${userId}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            disabled={pending}
          />
        </div>
        <StepUpField
          value={credential}
          onChange={setCredential}
          disabled={pending}
          label="Fresh TOTP or passkey"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={pending || reason.trim().length < 4 || !credential}
          >
            Confirm {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
