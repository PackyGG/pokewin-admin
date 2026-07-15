"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
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
import {
  processWithdrawal,
  shipWithdrawal,
  completeWithdrawal,
  cancelWithdrawal,
  failWithdrawal,
} from "../actions";

export function WithdrawalActionButtons({
  withdrawalId,
  status,
  method,
}: {
  withdrawalId: string;
  status: string;
  method: string;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("");
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [processOpen, setProcessOpen] = useState(false);

  // Legacy throw-style helper — used for actions that haven't migrated
  // to the ServerActionResult contract yet (ship / complete / fail).
  function handleAction(action: () => Promise<void>, label: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(`Withdrawal ${label}`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to ${label}`);
      }
    });
  }

  // New-style helper — for actions that return ServerActionResult.
  // The action never throws, so the toast branches on result.success.
  function handleResultAction(
    action: () => Promise<{ success: true } | { success: false; error: string }>,
    label: string,
  ) {
    startTransition(async () => {
      const result = await action();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Withdrawal ${label}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      {/* Process: pending → processing — TOTP-gated */}
      {status === "pending" && (
        <AlertDialog
          open={processOpen}
          onOpenChange={(v) => {
            setProcessOpen(v);
            if (!v) setTotpCode("");
          }}
        >
          <AlertDialogTrigger render={<Button size="sm" disabled={isPending} />}>
            {isPending ? "Processing..." : "Process"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Process Withdrawal</AlertDialogTitle>
              <AlertDialogDescription>
                For crypto withdrawals this initiates the Fireblocks transfer.
                Enter your 2FA code to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <StepUpField value={totpCode} onChange={setTotpCode} />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                disabled={isPending || !totpCode.trim()}
                onClick={() => {
                  handleResultAction(
                    () => processWithdrawal(withdrawalId, totpCode.trim()),
                    "processed",
                  );
                  setTotpCode("");
                  setProcessOpen(false);
                }}
              >
                Confirm Process
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Ship: processing → shipped (physical only) */}
      {status === "processing" && method === "physical" && (
        <AlertDialog>
          <AlertDialogTrigger render={<Button size="sm" variant="outline" />}>
            Ship
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Ship Withdrawal</AlertDialogTitle>
              <AlertDialogDescription>
                Enter shipping details.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Tracking Number</Label>
                <Input
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-2">
                <Label>Carrier</Label>
                <Input
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  placeholder="e.g. USPS, UPS, FedEx"
                />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending}
                onClick={() =>
                  handleAction(
                    () => shipWithdrawal(withdrawalId, trackingNumber, carrier),
                    "shipped"
                  )
                }
              >
                Confirm Ship
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Complete: processing|shipped → completed */}
      {["processing", "shipped"].includes(status) && (
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => handleAction(() => completeWithdrawal(withdrawalId), "completed")}
        >
          Complete
        </Button>
      )}

      {/* Cancel: pending|processing → cancelled — TOTP-gated (refunds user) */}
      {["pending", "processing"].includes(status) && (
        <AlertDialog
          onOpenChange={(v) => {
            if (!v) setTotpCode("");
          }}
        >
          <AlertDialogTrigger render={<Button size="sm" variant="destructive" />}>
            Cancel
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel Withdrawal</AlertDialogTitle>
              <AlertDialogDescription>
                Items will be restored to the user&apos;s inventory.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Textarea
              placeholder="Cancellation reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <StepUpField value={totpCode} onChange={setTotpCode} />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending || !reason.trim() || !totpCode.trim()}
                onClick={() => {
                  handleResultAction(
                    () =>
                      cancelWithdrawal(withdrawalId, reason, totpCode.trim()),
                    "cancelled",
                  );
                  setReason("");
                  setTotpCode("");
                }}
              >
                Confirm Cancel
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Fail: shipped → failed — TOTP-gated (refunds user) */}
      {status === "shipped" && (
        <AlertDialog
          onOpenChange={(v) => {
            if (!v) setTotpCode("");
          }}
        >
          <AlertDialogTrigger render={<Button size="sm" variant="destructive" />}>
            Mark Failed
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark as Failed</AlertDialogTitle>
              <AlertDialogDescription>
                This will mark the shipped withdrawal as failed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Textarea
              placeholder="Failure reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <StepUpField value={totpCode} onChange={setTotpCode} />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending || !reason.trim() || !totpCode.trim()}
                onClick={() => {
                  handleAction(
                    () =>
                      failWithdrawal(withdrawalId, reason, totpCode.trim()),
                    "failed",
                  );
                  setReason("");
                  setTotpCode("");
                }}
              >
                Confirm Failed
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
