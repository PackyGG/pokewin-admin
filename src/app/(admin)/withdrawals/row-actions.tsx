"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal, Check, X, Truck, PackageCheck, AlertTriangle } from "lucide-react";
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

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() => startTransition(() => processWithdrawal(withdrawalId))}
      >
        <Check className="mr-1 h-3 w-3" />
        Approve
      </Button>
      <AlertDialog open={declineOpen} onOpenChange={setDeclineOpen}>
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
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!reason.trim()}
              onClick={() =>
                startTransition(async () => {
                  await cancelWithdrawal(withdrawalId, reason);
                  setReason("");
                  setDeclineOpen(false);
                })
              }
            >
              Decline
            </AlertDialogAction>
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

      {/* Reason dialog (cancel / fail) */}
      <AlertDialog open={reasonOpen} onOpenChange={setReasonOpen}>
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
          <AlertDialogFooter>
            <AlertDialogCancel>Go Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={!reason.trim()}
              onClick={() =>
                startTransition(async () => {
                  if (reasonAction === "cancel") {
                    await cancelWithdrawal(withdrawalId, reason);
                  } else {
                    await failWithdrawal(withdrawalId, reason);
                  }
                  setReason("");
                  setReasonOpen(false);
                })
              }
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
