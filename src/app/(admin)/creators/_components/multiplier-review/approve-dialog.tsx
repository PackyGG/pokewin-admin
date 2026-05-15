"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { approveMultiplierDeal } from "../../multiplier-actions";
import { formatBps, formatStringUsd } from "./shared";

type Props = {
  deal: MultiplierDealResponse;
  trigger: React.ReactNode;
  onSuccess?: () => void;
};

/**
 * Approve dialog — issues the payout voucher and finalizes the deal.
 *
 * The calculated payout = ending_balance × withdrawable_bps, clamped by
 * max_payout_usd (if set). Admin can optionally:
 *   - Override the wager requirement (required if WAGER_REQUIREMENT_UNMET
 *     is in flagged_reasons — otherwise the backend rejects the approve).
 *   - Manually reduce the payout via `payout_override_usd` (any reduction
 *     becomes an admin_payout_override forfeiture for audit).
 *
 * Live preview shows what the user will receive vs what gets forfeited
 * with the current inputs.
 */
export function MultiplierApproveDialog({ deal, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [overrideWagerReq, setOverrideWagerReq] = useState(false);
  const [payoutOverride, setPayoutOverride] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  // Wager requirement check — backend exposes the flagged_reasons array.
  // Disable the submit button if the unmet flag is present and admin
  // hasn't ticked the override box.
  const wagerReqUnmet = useMemo(
    () =>
      (deal.flagged_reasons ?? []).some(
        (f) => f.code === "WAGER_REQUIREMENT_UNMET",
      ),
    [deal.flagged_reasons],
  );

  // Calculated payout (mirror of the backend math). Pure UI preview —
  // backend recomputes on the actual approve call.
  const endingBalance = Number(deal.ending_balance_usd ?? 0);
  const rawPayout = Math.floor(
    (endingBalance * deal.withdrawable_bps) / 10000 * 100,
  ) / 100;
  const maxPayout = deal.max_payout_usd
    ? Number(deal.max_payout_usd)
    : null;
  const cappedPayout =
    maxPayout !== null ? Math.min(rawPayout, maxPayout) : rawPayout;
  const overrideAmount = payoutOverride ? Number(payoutOverride) : NaN;
  const overrideValid =
    payoutOverride === "" ||
    (Number.isFinite(overrideAmount) &&
      overrideAmount >= 0 &&
      overrideAmount <= cappedPayout);
  const finalPayout =
    payoutOverride !== "" && Number.isFinite(overrideAmount)
      ? overrideAmount
      : cappedPayout;
  const totalForfeited = Math.max(0, endingBalance - finalPayout);

  const disabled =
    isPending ||
    !overrideValid ||
    (wagerReqUnmet && !overrideWagerReq);

  function reset() {
    setOverrideWagerReq(false);
    setPayoutOverride("");
    setReason("");
  }

  function submit() {
    startTransition(async () => {
      try {
        await approveMultiplierDeal(deal.user_id, deal.id, {
          override_wager_requirement: wagerReqUnmet
            ? overrideWagerReq
            : undefined,
          payout_override_usd:
            payoutOverride !== "" && Number.isFinite(overrideAmount)
              ? overrideAmount
              : undefined,
          reason: reason.trim() || undefined,
        });
        toast.success("Multiplier deal approved");
        setOpen(false);
        reset();
        onSuccess?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to approve deal",
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
            <CheckCircle2 className="size-5 text-violet-500" />
            Approve Multiplier Deal
          </DialogTitle>
          <DialogDescription>
            Issue the payout voucher and finalize this deal. The user keeps
            a fraction of their ending balance; the rest is forfeited per
            the deal contract.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Calculation preview */}
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <div className="text-muted-foreground">Ending balance</div>
              <div className="text-right font-medium">
                {formatStringUsd(deal.ending_balance_usd)}
              </div>
              <div className="text-muted-foreground">
                Withdrawable ({formatBps(deal.withdrawable_bps)})
              </div>
              <div className="text-right font-medium">
                {formatStringUsd(String(rawPayout))}
              </div>
              {maxPayout !== null && cappedPayout < rawPayout && (
                <>
                  <div className="text-muted-foreground">
                    Max payout cap
                  </div>
                  <div className="text-right font-medium">
                    {formatStringUsd(String(maxPayout))}
                  </div>
                </>
              )}
              <Separator className="col-span-2 my-1" />
              <div className="font-medium">Voucher payout</div>
              <div className="text-right font-semibold text-rose-500">
                {formatStringUsd(String(finalPayout))}
              </div>
              <div className="text-muted-foreground">Forfeited</div>
              <div className="text-right font-medium text-emerald-500">
                {formatStringUsd(String(totalForfeited))}
              </div>
            </div>
          </div>

          {/* Wager req override — only shown if flag present */}
          {wagerReqUnmet && (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="override-wager-req"
                  checked={overrideWagerReq}
                  onCheckedChange={(v) =>
                    setOverrideWagerReq(v === true)
                  }
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="override-wager-req"
                    className="cursor-pointer text-sm font-medium"
                  >
                    Override wager requirement
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    The creator did not meet the contractual wager req
                    ({formatStringUsd(deal.wager_accumulated_usd)} of{" "}
                    {formatStringUsd(
                      String(
                        (Number(deal.total_loaded_usd ?? 0) *
                          deal.wager_requirement_bps) /
                          10000,
                      ),
                    )}{" "}
                    required). Approval is blocked without this override.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Payout override (optional) */}
          <div className="space-y-2">
            <Label htmlFor="payout-override">
              Payout override ($) — optional
            </Label>
            <Input
              id="payout-override"
              type="number"
              step="0.01"
              min="0"
              max={cappedPayout}
              placeholder={cappedPayout.toFixed(2)}
              value={payoutOverride}
              onChange={(e) => setPayoutOverride(e.target.value)}
              className={!overrideValid ? "border-rose-500" : undefined}
            />
            <p className="text-xs text-muted-foreground">
              Manually reduce the voucher value below the calculated amount.
              The shortfall becomes an admin_payout_override forfeiture in
              the audit trail. Leave blank to use the calculation.
            </p>
            {!overrideValid && (
              <p className="text-xs text-rose-500">
                Must be a number between 0 and{" "}
                {formatStringUsd(String(cappedPayout))}.
              </p>
            )}
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="approve-reason">Reason (optional)</Label>
            <Textarea
              id="approve-reason"
              placeholder="e.g. flagged for low duration but stream content checks out"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose
            render={<Button variant="ghost" disabled={isPending} />}
          >
            Cancel
          </DialogClose>
          <Button onClick={submit} disabled={disabled}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Approving…
              </>
            ) : (
              <>
                Approve & issue {formatStringUsd(String(finalPayout))} voucher
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
