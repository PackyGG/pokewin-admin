"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { MoreHorizontal, Check, X, Truck, PackageCheck, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import {
  processWithdrawal,
  cancelWithdrawal,
  shipWithdrawal,
  completeWithdrawal,
  failWithdrawal,
} from "./actions";

export function WithdrawalRequestActions({ withdrawalId }: { withdrawalId: string }) {
  const [isPending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [declineOpen, setDeclineOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  return (
    <div className="flex items-center gap-1">
      <AlertDialog
        open={approveOpen}
        onOpenChange={(v) => {
          setApproveOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <AlertDialogTrigger render={<Button size="sm" variant="outline" disabled={isPending} />}>
          <Check className="mr-1 h-3 w-3" />
          Approve
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
              disabled={!totpCode.trim() || isPending}
              onClick={() => {
                startTransition(async () => {
                  // ServerActionResult — branch on result.success.
                  const result = await processWithdrawal(
                    withdrawalId,
                    totpCode.trim(),
                  );
                  if (!result.success) {
                    toast.error(result.error);
                    return;
                  }
                  toast.success("Withdrawal processed");
                  setTotpCode("");
                  setApproveOpen(false);
                });
              }}
            >
              Approve
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={declineOpen}
        onOpenChange={(v) => {
          setDeclineOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <AlertDialogTrigger render={<Button size="sm" variant="outline" disabled={isPending} />}>
          <X className="mr-1 h-3 w-3" />
          Decline
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline Withdrawal</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the withdrawal and unlock the user&apos;s items.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason for declining..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <StepUpField value={totpCode} onChange={setTotpCode} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={!reason.trim() || !totpCode.trim() || isPending}
              onClick={() => {
                startTransition(async () => {
                  // ServerActionResult — branch on result.success.
                  const result = await cancelWithdrawal(
                    withdrawalId,
                    reason,
                    totpCode.trim(),
                  );
                  if (!result.success) {
                    toast.error(result.error);
                    return;
                  }
                  toast.success("Withdrawal declined");
                  setReason("");
                  setTotpCode("");
                  setDeclineOpen(false);
                });
              }}
            >
              Decline
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ActiveShipmentActions({
  withdrawalId,
  status,
}: {
  withdrawalId: string;
  status: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [shipOpen, setShipOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<"cancel" | "fail">("cancel");
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" disabled={isPending} />}>
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {status === "processing" && (
            <>
              <DropdownMenuItem onSelect={() => setShipOpen(true)}>
                <Truck className="mr-2 h-4 w-4" />
                Mark Shipped
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => startTransition(() => completeWithdrawal(withdrawalId))}
              >
                <PackageCheck className="mr-2 h-4 w-4" />
                Complete
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setReasonAction("cancel");
                  setReasonOpen(true);
                }}
              >
                <X className="mr-2 h-4 w-4" />
                Cancel
              </DropdownMenuItem>
            </>
          )}
          {status === "shipped" && (
            <>
              <DropdownMenuItem
                onSelect={() => startTransition(() => completeWithdrawal(withdrawalId))}
              >
                <PackageCheck className="mr-2 h-4 w-4" />
                Complete
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setReasonAction("fail");
                  setReasonOpen(true);
                }}
              >
                <AlertTriangle className="mr-2 h-4 w-4" />
                Mark Failed
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Ship dialog */}
      <Dialog open={shipOpen} onOpenChange={setShipOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as Shipped</DialogTitle>
            <DialogDescription>
              Enter tracking information for this shipment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="tracking">Tracking Number</Label>
              <Input
                id="tracking"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="e.g. 1Z999AA10123456784"
              />
            </div>
            <div>
              <Label htmlFor="carrier">Carrier</Label>
              <Input
                id="carrier"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="e.g. UPS, FedEx, USPS"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShipOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                startTransition(async () => {
                  await shipWithdrawal(withdrawalId, tracking, carrier);
                  setTracking("");
                  setCarrier("");
                  setShipOpen(false);
                })
              }
              disabled={isPending}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reason + TOTP dialog (cancel / fail — both refund the user) */}
      <AlertDialog
        open={reasonOpen}
        onOpenChange={(v) => {
          setReasonOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reasonAction === "cancel" ? "Cancel Withdrawal" : "Mark as Failed"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reasonAction === "cancel"
                ? "This will cancel the withdrawal and unlock the user's items."
                : "This will mark the shipment as failed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <StepUpField value={totpCode} onChange={setTotpCode} />
          <AlertDialogFooter>
            <AlertDialogCancel>Go Back</AlertDialogCancel>
            <Button
              disabled={!reason.trim() || !totpCode.trim() || isPending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    if (reasonAction === "cancel") {
                      // cancelWithdrawal returns ServerActionResult —
                      // failWithdrawal still throws (not migrated).
                      const result = await cancelWithdrawal(
                        withdrawalId,
                        reason,
                        totpCode.trim(),
                      );
                      if (!result.success) {
                        toast.error(result.error);
                        return;
                      }
                      toast.success("Withdrawal cancelled");
                    } else {
                      await failWithdrawal(withdrawalId, reason, totpCode.trim());
                      toast.success("Withdrawal marked failed");
                    }
                    setReason("");
                    setTotpCode("");
                    setReasonOpen(false);
                  } catch (e) {
                    toast.error(
                      e instanceof Error ? e.message : "Action failed",
                    );
                  }
                })
              }
            >
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Dispatcher — picks the right action set based on the withdrawal's
 * current status. Used by the unified single-page withdrawals table so
 * each row gets the actions that actually apply to its state, and no
 * buttons render for terminal states (completed/cancelled/failed).
 */
export function WithdrawalRowActions({
  withdrawalId,
  status,
  method,
}: {
  withdrawalId: string;
  status: string;
  method: string;
}) {
  // Terminal states — no actions available.
  if (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed"
  ) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }

  // processing / shipped and method is physical → active shipment actions
  // (mark shipped, complete, cancel, fail).
  if (
    (status === "processing" || status === "shipped") &&
    method === "physical"
  ) {
    return (
      <ActiveShipmentActions withdrawalId={withdrawalId} status={status} />
    );
  }

  // Everything else pending / processing non-physical → request actions
  // (approve, decline).
  return <WithdrawalRequestActions withdrawalId={withdrawalId} />;
}
