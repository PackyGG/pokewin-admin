"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { XCircle } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cancelWithdrawal } from "@/app/(admin)/withdrawals/actions";

/**
 * Per-row Decline affordance for card withdrawals on the user-detail page.
 *
 * Wraps the existing `cancelWithdrawal` server action (same action used on
 * the /withdrawals page) so admins can sync the dashboard state without
 * leaving the user profile when a crypto withdrawal was already declined
 * on Fireblocks.
 *
 * - No new mutation path: same audit event (withdrawal_cancelled), same
 *   backend refund flow, same TOTP + capability gates as /withdrawals.
 * - Renders nothing for terminal states (completed/cancelled/failed/shipped).
 * - Visibility is server-gated; the button shows for everyone but the action
 *   throws server-side for non-permitted users — mirrors /withdrawals.
 */
export function WithdrawalDeclineButton({
  withdrawalId,
  status,
  method: _method,
}: {
  withdrawalId: string;
  status: string;
  method: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");

  // Only pending / processing withdrawals can be declined-and-refunded;
  // terminal states (completed / cancelled / failed) and shipped (already
  // dispatched) have no decline affordance here.
  if (status !== "pending" && status !== "processing") {
    return null;
  }

  // Wrap the whole dialog in a propagation-stopping div so clicks on the
  // trigger button and anywhere inside the dialog (textarea, input, footer
  // buttons) don't bubble up to the parent TableRow's onClick handler,
  // which opens /withdrawals/{id} in a new tab.
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setReason("");
            setTotpCode("");
          }
        }}
      >
        <AlertDialogTrigger
          render={<Button size="sm" variant="outline" disabled={isPending} />}
        >
          <XCircle className="mr-1 h-3 w-3" />
          Decline
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline Withdrawal</AlertDialogTitle>
            <AlertDialogDescription>
              Cancels the withdrawal and refunds the user&apos;s balance. Use
              this when the withdrawal was already declined on Fireblocks and
              you need to sync the admin dashboard state.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason for declining... (e.g. declined on Fireblocks)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">2FA Code</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Enter your 6-digit code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={!reason.trim() || !totpCode.trim() || isPending}
              onClick={() => {
                startTransition(async () => {
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
                  setOpen(false);
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
