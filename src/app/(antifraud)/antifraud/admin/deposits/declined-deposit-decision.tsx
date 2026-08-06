"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { resolveDeclinedDepositAction } from "./actions";

type ResolutionAction = "refund" | "ban" | "refund_and_ban";

const LABELS: Record<ResolutionAction, string> = {
  refund: "Refund only",
  ban: "Ban only",
  refund_and_ban: "Refund + ban",
};

const CONFIRMATIONS: Record<ResolutionAction, string> = {
  refund: "REFUND",
  ban: "BAN",
  refund_and_ban: "REFUND AND BAN",
};

export function DeclinedDepositDecision({
  caseId,
  amount,
  status,
  version,
}: {
  caseId: string;
  amount: string;
  status: string;
  version: number;
}) {
  const router = useRouter();
  const [action, setAction] = useState<ResolutionAction | null>(null);
  const [reason, setReason] = useState("");
  const [credential, setCredential] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, startTransition] = useTransition();
  const actionable = status === "declined" || status === "resolution_failed";

  function open(next: ResolutionAction) {
    setAction(next);
    setReason("");
    setCredential("");
    setConfirmation("");
  }

  function submit() {
    if (!action) return;
    startTransition(async () => {
      const result = await resolveDeclinedDepositAction({
        caseId,
        action,
        reason,
        credential,
        confirmation,
        expectedVersion: version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast[result.status === "resolved" ? "success" : "warning"](result.message);
      setAction(null);
      router.refresh();
    });
  }

  if (!actionable) {
    return <span className="self-center text-xs text-muted-foreground">No decision available</span>;
  }

  return (
    <>
      <div className="flex flex-wrap content-start gap-2 lg:max-w-72 lg:justify-end">
        <Button size="sm" variant="outline" onClick={() => open("refund")}>Refund only</Button>
        <Button size="sm" variant="destructive" onClick={() => open("ban")}>Ban only</Button>
        <Button size="sm" variant="destructive" onClick={() => open("refund_and_ban")}>Refund + ban</Button>
      </div>
      <AlertDialog open={action !== null} onOpenChange={(openState) => !openState && !pending && setAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{action ? LABELS[action] : "Resolve deposit"} for {amount}?</AlertDialogTitle>
            <AlertDialogDescription>
              The staff decline locks remain in place. Ban-only keeps the payment without crediting or refunding it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`resolution-reason-${caseId}`}>Decision reason</Label>
            <Textarea id={`resolution-reason-${caseId}`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} disabled={pending} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`resolution-confirm-${caseId}`}>
              Type {action ? CONFIRMATIONS[action] : "the confirmation"}
            </Label>
            <input
              id={`resolution-confirm-${caseId}`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={pending}
            />
          </div>
          <StepUpField value={credential} onChange={setCredential} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              variant={action === "refund" ? "default" : "destructive"}
              disabled={!action || reason.trim().length < 3 || !credential.trim() || confirmation !== (action ? CONFIRMATIONS[action] : "") || pending}
              onClick={submit}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {pending ? "Working..." : action ? LABELS[action] : "Resolve"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
