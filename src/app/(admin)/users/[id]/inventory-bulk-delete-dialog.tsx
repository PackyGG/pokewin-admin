"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { bulkDeleteUserInventoryItems } from "./actions";

const INVENTORY_DELETE_MIN_REASON_CHARS = 20;

/**
 * Bulk inventory removal — same reason + 2FA gate as the single-item
 * dialog, but removes every selected item in one action. Invalid items
 * (sold / locked / tied to a withdrawal) are skipped server-side and
 * reported back, so a mixed selection still removes what it can.
 */
export function InventoryBulkDeleteDialog({
  userId,
  itemIds,
  totalValue,
  open,
  onOpenChange,
  onDeleted,
}: {
  userId: string;
  itemIds: string[];
  totalValue: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleClose(next: boolean) {
    if (isPending) return;
    if (!next) {
      setReason("");
      setTotpCode("");
    }
    onOpenChange(next);
  }

  function handleDelete() {
    const trimmedReason = reason.trim();
    if (trimmedReason.length < INVENTORY_DELETE_MIN_REASON_CHARS) {
      toast.error(
        `Reason must be at least ${INVENTORY_DELETE_MIN_REASON_CHARS} characters`,
      );
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }

    startTransition(async () => {
      try {
        const result = await bulkDeleteUserInventoryItems({
          userId,
          inventoryItemIds: itemIds,
          reason: trimmedReason,
          totpCode: totpCode.trim(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const skippedNote =
          result.skipped > 0
            ? ` (${result.skipped} skipped${result.firstError ? `: ${result.firstError}` : ""})`
            : "";
        toast.success(`Removed ${result.deleted} item(s)${skippedNote}`);
        setReason("");
        setTotpCode("");
        onOpenChange(false);
        onDeleted?.();
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to remove items",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Remove {itemIds.length} inventory item
            {itemIds.length !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <p className="font-medium">
              {itemIds.length} item{itemIds.length !== 1 ? "s" : ""} selected
            </p>
            <p className="text-muted-foreground tabular-nums">
              Total value {formatCurrency(totalValue)}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inventory-bulk-delete-reason">Reason</Label>
            <Textarea
              id="inventory-bulk-delete-reason"
              placeholder={`Why are these items being removed? (min ${INVENTORY_DELETE_MIN_REASON_CHARS} characters)`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={isPending}
            />
            <p className="text-[10px] text-muted-foreground">
              {reason.trim().length}/{INVENTORY_DELETE_MIN_REASON_CHARS}{" "}
              characters minimum. Each removal is recorded in the
              user&apos;s transactions box. Sold / locked items are skipped.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inventory-bulk-delete-2fa">2FA code</Label>
            <Input
              id="inventory-bulk-delete-2fa"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              disabled={isPending}
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isPending}
            className="gap-1.5"
          >
            <Trash2 className="size-4" />
            {isPending ? "Removing…" : `Remove ${itemIds.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
