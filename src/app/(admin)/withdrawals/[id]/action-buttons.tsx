"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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

  return (
    <div className="flex flex-wrap gap-2">
      {/* Process: pending → processing */}
      {status === "pending" && (
        <Button
          size="sm"
          disabled={isPending}
          onClick={() => handleAction(() => processWithdrawal(withdrawalId), "processed")}
        >
          {isPending ? "Processing..." : "Process"}
        </Button>
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

      {/* Cancel: pending|processing → cancelled */}
      {["pending", "processing"].includes(status) && (
        <AlertDialog>
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
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending || !reason.trim()}
                onClick={() =>
                  handleAction(
                    () => cancelWithdrawal(withdrawalId, reason),
                    "cancelled"
                  )
                }
              >
                Confirm Cancel
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Fail: shipped → failed */}
      {status === "shipped" && (
        <AlertDialog>
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
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending || !reason.trim()}
                onClick={() =>
                  handleAction(
                    () => failWithdrawal(withdrawalId, reason),
                    "failed"
                  )
                }
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
