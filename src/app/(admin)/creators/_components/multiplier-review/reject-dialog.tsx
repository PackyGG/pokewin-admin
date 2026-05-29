"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, XCircle } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { rejectMultiplierDeal } from "../../multiplier-actions";
import { formatStringUsd } from "./shared";

type Props = {
  deal: MultiplierDealResponse;
  trigger: React.ReactNode;
  onSuccess?: () => void;
};

/**
 * Reject dialog — no payout voucher, ending balance fully forfeited,
 * deposit refunded by default. Admin can override the refund to forfeit
 * part or all of the deposit as a punitive measure (TOS abuse).
 *
 * `forfeit_deposit_usd`:
 *   0 (default) → full refund
 *   user_funding_usd → full forfeit (no refund at all)
 *   in between    → partial split
 *
 * Reason is required — every reject leaves an audit explanation.
 */
export function MultiplierRejectDialog({ deal, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [forfeitInput, setForfeitInput] = useState("0");
  const [isPending, startTransition] = useTransition();

  const userFunding = Number(deal.user_funding_usd ?? 0);

  const forfeit = useMemo(() => {
    const n = Number(forfeitInput);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n > userFunding) return null;
    return n;
  }, [forfeitInput, userFunding]);

  const refundAmount = forfeit !== null ? userFunding - forfeit : 0;
  const reasonValid = reason.trim().length > 0;
  const disabled = isPending || !reasonValid || forfeit === null;

  function reset() {
    setReason("");
    setForfeitInput("0");
  }

  function submit() {
    if (forfeit === null) return;
    startTransition(async () => {
      try {
        await rejectMultiplierDeal(deal.user_id, deal.id, {
          reason: reason.trim(),
          forfeit_deposit_usd: forfeit > 0 ? forfeit : undefined,
        });
        toast.success("Multiplier deal rejected");
        setOpen(false);
        reset();
        onSuccess?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to reject deal",
        );
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="size-5 text-rose-500" />
            Reject Multiplier Deal
          </DialogTitle>
          <DialogDescription>
            No payout voucher will be issued. The ending balance is
            forfeited. Choose how much of the creator&apos;s deposit to
            refund vs forfeit as a TOS-abuse penalty.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <div className="text-muted-foreground">Locked deposit</div>
              <div className="text-right font-medium">
                {formatStringUsd(deal.user_funding_usd)}
              </div>
              <div className="text-muted-foreground">Ending balance (forfeited)</div>
              <div className="text-right font-medium text-emerald-500">
                {formatStringUsd(deal.ending_balance_usd)}
              </div>
              <Separator className="col-span-2 my-1" />
              <div className="font-medium">Deposit refunded to user</div>
              <div className="text-right font-semibold text-rose-500">
                {formatStringUsd(String(refundAmount))}
              </div>
              <div className="font-medium">Deposit forfeited (punitive)</div>
              <div className="text-right font-semibold text-emerald-500">
                {formatStringUsd(String(forfeit ?? 0))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="forfeit-amount">
              Forfeit deposit ($) — 0 = full refund, {userFunding.toFixed(2)} = full forfeit
            </Label>
            <Input
              id="forfeit-amount"
              type="number"
              step="0.01"
              min="0"
              max={userFunding}
              value={forfeitInput}
              onChange={(e) => setForfeitInput(e.target.value)}
              className={forfeit === null ? "border-rose-500" : undefined}
            />
            {forfeit === null && (
              <p className="text-xs text-rose-500">
                Must be a number between 0 and{" "}
                {formatStringUsd(deal.user_funding_usd)}.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reject-reason">
              Reason <span className="text-rose-500">*</span>
            </Label>
            <Textarea
              id="reject-reason"
              placeholder="e.g. low activity, suspected collusion, missing VOD without explanation"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              required
            />
            {!reasonValid && (
              <p className="text-xs text-muted-foreground">
                A reason is required for every reject.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <DialogClose
            render={<Button variant="ghost" disabled={isPending} />}
          >
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={disabled}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Rejecting…
              </>
            ) : (
              <>Reject deal</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
