"use client";

import { useState, useTransition } from "react";
import { HandCoins } from "lucide-react";
import { toast } from "sonner";

import { StepUpField } from "@/components/step-up-field";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ux";
import { formatCurrency } from "@/lib/utils/format";

import { calculateCreatorPnlAction, creditCreatorPnlShareAction } from "./pnl-settlement-actions";

export function PnlCalculateButton(props: { userId: string; dealId: string; expectedVersion: number }) {
  const [pending, startTransition] = useTransition();
  return <Button type="button" size="sm" variant="outline" disabled={pending}
    onClick={() => startTransition(async () => {
      const result = await calculateCreatorPnlAction(props);
      if (!result.success) { toast.error(result.error); return; }
      toast.success(`Frozen frame preview · recommended share ${formatCurrency(result.creatorShareUsd)}`);
    })}>
    {pending ? <Spinner size={14} /> : <HandCoins className="size-3.5" />}
    {pending ? "Calculating…" : "Calculate frame"}
  </Button>;
}

export function PnlSettlementButton(props: {
  userId: string;
  dealId: string;
  expectedVersion: number;
  computedShareUsd: number | null;
  initialAmountUsd: number | null;
  retry: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(
    props.initialAmountUsd == null
      ? (props.computedShareUsd == null ? "" : props.computedShareUsd.toFixed(2))
      : props.initialAmountUsd.toFixed(2),
  );
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [pending, startTransition] = useTransition();
  const amountUsd = Number(amount);
  const valid = Number.isFinite(amountUsd) && amountUsd > 0
    && Math.round(amountUsd * 100) === amountUsd * 100
    && reason.trim().length >= 3 && confirmation === "CREDIT" && Boolean(totpCode.trim());

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <HandCoins className="size-3.5" />
        {props.retry ? "Retry manual credit" : "Credit payout"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Credit creator PnL payout</DialogTitle>
            <DialogDescription>
              Enter the approved manual payout. This immediately increases the creator&apos;s
              withdrawable balance and does not add wager debt.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {props.computedShareUsd != null && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                Computed contractual share: <b>{formatCurrency(props.computedShareUsd)}</b>.
                The manual credit may differ, and both values remain in the audit record.
              </div>
            )}
            {props.computedShareUsd != null && Number.isFinite(amountUsd)
              && Math.abs(amountUsd - props.computedShareUsd) >= 0.005 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Manual override: this differs from the computed share by {formatCurrency(amountUsd - props.computedShareUsd)}. Explain the override in the reason field.
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="pnl-credit-amount">Manual payout (USD)</Label>
              <Input id="pnl-credit-amount" inputMode="decimal" value={amount}
                onChange={(event) => setAmount(event.target.value)} disabled={pending} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pnl-credit-reason">Reason</Label>
              <Input id="pnl-credit-reason" value={reason}
                onChange={(event) => setReason(event.target.value)} maxLength={500} disabled={pending} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pnl-credit-confirm">Type CREDIT to confirm</Label>
              <Input id="pnl-credit-confirm" value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)} disabled={pending} />
            </div>
            <StepUpField value={totpCode} onChange={setTotpCode} disabled={pending} />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={pending || !valid} onClick={() => startTransition(async () => {
              const result = await creditCreatorPnlShareAction({
                userId: props.userId, dealId: props.dealId,
                expectedVersion: props.expectedVersion, amountUsd, reason, totpCode,
              });
              if (!result.success) { toast.error(result.error); return; }
              toast.success(`Credited ${formatCurrency(result.amountUsd)} to the creator`);
              setOpen(false);
            })}>
              {pending ? <Spinner size={14} /> : <HandCoins className="size-4" />}
              {pending ? "Crediting…" : `Credit ${Number.isFinite(amountUsd) ? formatCurrency(amountUsd) : "payout"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
