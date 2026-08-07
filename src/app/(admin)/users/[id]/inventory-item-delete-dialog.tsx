"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StepUpField } from "@/components/step-up-field";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { deleteUserInventoryItem } from "./actions";
import {
  AbuserTagToggles,
  applyAbuserTags,
  useAbuserTags,
} from "./abuser-tag-toggles";
import type { InventoryItem } from "./user-tabs-types";

const INVENTORY_DELETE_MIN_REASON_CHARS = 20;

export function InventoryItemDeleteDialog({
  userId,
  item,
  open,
  onOpenChange,
  onDeleted,
}: {
  userId: string;
  item: InventoryItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const abuser = useAbuserTags();
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleClose(next: boolean) {
    if (isPending) return;
    if (!next) {
      setReason("");
      setTotpCode("");
      abuser.reset();
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
        const result = await deleteUserInventoryItem({
          userId,
          inventoryItemId: item.id,
          reason: trimmedReason,
          totpCode: totpCode.trim(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Inventory item removed");
        await applyAbuserTags(userId, abuser.selected);
        setReason("");
        setTotpCode("");
        abuser.reset();
        onOpenChange(false);
        onDeleted?.();
        router.refresh();
      } catch (err) {
        // Without this catch a thrown server action rejected silently — the
        // dialog just sat there and the item never left. Surface the reason.
        toast.error(
          err instanceof Error
            ? err.message
            : "Failed to remove inventory item",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove inventory item</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <p className="font-medium truncate">{item.cardName}</p>
            <p className="text-muted-foreground tabular-nums">
              {formatCurrency(item.value)}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inventory-delete-reason">Reason</Label>
            <Textarea
              id="inventory-delete-reason"
              placeholder={`Why is this item being removed? (min ${INVENTORY_DELETE_MIN_REASON_CHARS} characters)`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={isPending}
            />
            <p className="text-[10px] text-muted-foreground">
              {reason.trim().length}/{INVENTORY_DELETE_MIN_REASON_CHARS}{" "}
              characters minimum. Permanently deletes the open inventory row —
              not a sale or exchange.
            </p>
          </div>
          <AbuserTagToggles state={abuser} disabled={isPending} />
          <StepUpField
            value={totpCode}
            onChange={setTotpCode}
            disabled={isPending}
          />
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
            {isPending ? "Removing…" : "Remove item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
