"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Settings, Eraser, ArrowRightLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import {
  zeroAffiliateClaimBalance,
  transferAffiliateCodeToMotha,
  type AffiliateCodeActionResult,
} from "./actions";

/**
 * Two-step confirm "Manage" dialog for a single affiliate code.
 *
 * Hosts the two audited, admin-only write actions:
 *   1. Zero the owner's claimable affiliate balance (available_usd → 0).
 *   2. Transfer the code's ownership to @motha.
 *
 * Each action is gated behind an explicit destructive confirm step that
 * summarises exactly what will change (which code, the amount to be zeroed
 * or the old→new owner). All props are serializable primitives — no
 * function props cross the RSC boundary.
 *
 * NOTE: both actions write to the MAIN (prod) DB and only succeed in
 * production; the server actions independently re-assert auth + audit.
 */
type Mode = "menu" | "confirm-zero" | "confirm-transfer";

export function ManageAffiliateCodeDialog({
  codeId,
  code,
  ownerUserId,
  ownerLabel,
  availableUsd,
  hasAccount,
}: {
  codeId: string;
  code: string;
  ownerUserId: string;
  ownerLabel: string;
  availableUsd: number;
  hasAccount: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [busy, setBusy] = useState(false);

  function reset() {
    setMode("menu");
    setBusy(false);
  }

  function handleResult(result: AffiliateCodeActionResult) {
    if (result.success) {
      toast.success(result.message);
      setOpen(false);
      reset();
    } else {
      toast.error(result.error);
      setBusy(false);
    }
  }

  async function runZero() {
    setBusy(true);
    try {
      const result = await zeroAffiliateClaimBalance({ codeId, ownerUserId });
      handleResult(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to zero balance");
      setBusy(false);
    }
  }

  async function runTransfer() {
    setBusy(true);
    try {
      const result = await transferAffiliateCodeToMotha({
        codeId,
        currentOwnerUserId: ownerUserId,
      });
      handleResult(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to transfer code");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="sm" className="gap-1.5" />}
      >
        <Settings className="size-3.5" aria-hidden />
        Manage
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {mode === "menu" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{code}</DialogTitle>
              <DialogDescription>
                Owner {ownerLabel}. These are sensitive, audited actions on the
                MAIN database.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <button
                type="button"
                onClick={() => setMode("confirm-zero")}
                disabled={!hasAccount || availableUsd === 0}
                className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-rose-500/20 bg-rose-500/10">
                  <Eraser className="size-4 text-rose-500" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    Zero claimable balance
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {hasAccount
                      ? `Set available to $0.00 (currently ${formatCurrency(availableUsd)}). Earned / paid-out history kept.`
                      : "Owner has no affiliate account row."}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode("confirm-transfer")}
                className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10">
                  <ArrowRightLeft className="size-4 text-amber-500" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    Transfer code to @motha
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Re-points code ownership only. History &amp; earnings stay
                    with the current owner.
                  </span>
                </span>
              </button>
            </div>
          </>
        )}

        {mode === "confirm-zero" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-rose-500">
                <AlertTriangle className="size-5" aria-hidden />
                Zero claimable balance?
              </DialogTitle>
              <DialogDescription>
                This sets the claimable affiliate balance for{" "}
                <span className="font-medium text-foreground">{ownerLabel}</span>{" "}
                (owner of <span className="font-mono">{code}</span>) from{" "}
                <span className="font-semibold text-rose-500">
                  {formatCurrency(availableUsd)}
                </span>{" "}
                to <span className="font-semibold">$0.00</span>. Total earned and
                paid-out history are NOT changed. This action is audited and
                cannot be undone from the UI.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setMode("menu")}
                disabled={busy}
              >
                Back
              </Button>
              <Button variant="destructive" onClick={runZero} disabled={busy}>
                {busy ? "Zeroing…" : `Zero ${formatCurrency(availableUsd)}`}
              </Button>
            </DialogFooter>
          </>
        )}

        {mode === "confirm-transfer" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-500">
                <AlertTriangle className="size-5" aria-hidden />
                Transfer code to @motha?
              </DialogTitle>
              <DialogDescription>
                This re-points ownership of{" "}
                <span className="font-mono">{code}</span> from{" "}
                <span className="font-medium text-foreground">{ownerLabel}</span>{" "}
                to <span className="font-medium text-foreground">@motha</span>.
                Only the code-ownership row moves — historical referrals and
                earnings stay attributed to the previous owner. This action is
                audited.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setMode("menu")}
                disabled={busy}
              >
                Back
              </Button>
              <Button onClick={runTransfer} disabled={busy}>
                {busy ? "Transferring…" : "Transfer to @motha"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
