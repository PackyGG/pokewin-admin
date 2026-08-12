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
      try {
        const result = await calculateCreatorPnlAction(props);
        if (!result.success) { toast.error(result.error); return; }
        toast.success(`Frozen frame preview · contractual payout ${formatCurrency(result.creatorShareUsd)}`);
      } catch {
        toast.error("Could not calculate the PnL frame. Refresh and retry.");
      }
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
  retry: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [pending, startTransition] = useTransition();
  const contractualAmountUsd = props.computedShareUsd;
  const hasPositivePayout = contractualAmountUsd != null && contractualAmountUsd > 0;
  const valid = hasPositivePayout && reason.trim().length >= 3
    && confirmation === "CREDIT" && Boolean(totpCode.trim());

  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={!hasPositivePayout} onClick={() => setOpen(true)}>
        <HandCoins className="size-3.5" />
        {!hasPositivePayout ? "No payout due" : props.retry ? "Retry credit" : "Credit payout"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Credit creator PnL payout</DialogTitle>
            <DialogDescription>
              Credit the frozen contractual payout. This immediately increases the
              creator&apos;s withdrawable balance and does not add wager debt. PnL
              payouts are never credited automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              Computed contractual share:{" "}
              <b>{contractualAmountUsd == null ? "—" : formatCurrency(contractualAmountUsd)}</b>.
              The payment amount is locked to the frozen calculation.
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
              if (contractualAmountUsd == null || contractualAmountUsd <= 0) return;
              try {
                const result = await creditCreatorPnlShareAction({
                  userId: props.userId, dealId: props.dealId,
                  expectedVersion: props.expectedVersion,
                  reason,
                  totpCode,
                });
                if (!result.success) { toast.error(result.error); return; }
                toast.success(`Credited ${formatCurrency(result.amountUsd)} to the creator`);
                setOpen(false);
              } catch {
                toast.error("Could not verify the PnL credit. Refresh and retry; the payment is idempotent.");
              }
            })}>
              {pending ? <Spinner size={14} /> : <HandCoins className="size-4" />}
              {pending ? "Crediting…" : `Credit ${contractualAmountUsd == null ? "payout" : formatCurrency(contractualAmountUsd)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
