"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BALANCE_ADJUSTMENT_CATEGORY_KEYS,
  BALANCE_ADJUSTMENT_CATEGORY_META,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import { formatCurrency } from "@/lib/utils/format";
import {
  getBalanceAdjustmentForEdit,
  updateBalanceAdjustmentMeta,
  type BalanceAdjustmentEditPayload,
} from "./actions";
import type { Transaction } from "./user-tabs-types";

const CATEGORY_OPTIONS = BALANCE_ADJUSTMENT_CATEGORY_KEYS.map((key) => ({
  value: key,
  label: BALANCE_ADJUSTMENT_CATEGORY_META[key].label,
}));

export function BalanceAdjustmentEditDialog({
  transaction,
  userId,
  open,
  onOpenChange,
}: {
  transaction: Transaction | null;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<BalanceAdjustmentEditPayload | null>(
    null,
  );
  const [category, setCategory] = useState<BalanceAdjustmentCategory | "">("");
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open || !transaction) {
      setPayload(null);
      setCategory("");
      setReason("");
      setTotpCode("");
      return;
    }

    let cancelled = false;
    setLoading(true);
    getBalanceAdjustmentForEdit(transaction.id, userId)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          toast.error(result.error);
          onOpenChange(false);
          return;
        }
        setPayload(result.data);
        setCategory(result.data.category ?? "");
        setReason(result.data.reason);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, transaction, userId, onOpenChange]);

  function handleSave() {
    if (!transaction || !payload) return;
    if (!reason.trim()) {
      toast.error("Description is required");
      return;
    }
    if (payload.kind === "admin" && !category) {
      toast.error("Please pick a category");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("2FA code is required");
      return;
    }

    startTransition(async () => {
      const result = await updateBalanceAdjustmentMeta({
        ledgerTxId: transaction.id,
        targetUserId: userId,
        category:
          payload.kind === "admin" && category !== ""
            ? category
            : undefined,
        reason: reason.trim(),
        totpCode: totpCode.trim(),
      });
      if (result.success) {
        toast.success("Balance adjustment updated");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit balance adjustment</DialogTitle>
        </DialogHeader>

        {loading || !payload || !transaction ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <p>
                <span className="font-medium text-foreground">ID:</span>{" "}
                <span className="font-mono">{transaction.id}</span>
              </p>
              <p>
                <span className="font-medium text-foreground">Amount:</span>{" "}
                {formatCurrency(payload.amount)}
              </p>
              {payload.kind === "manual" && (
                <p className="text-amber-600 dark:text-amber-400">
                  Manual withdrawal — only the description can be edited.
                </p>
              )}
            </div>

            {payload.kind === "admin" && (
              <div className="space-y-2">
                <Label>Category (tag)</Label>
                <Select
                  value={category}
                  onValueChange={(v) =>
                    v && setCategory(v as BalanceAdjustmentCategory)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Description / reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                placeholder="Reason shown on the ledger row"
              />
            </div>

            <div className="space-y-2">
              <Label>2FA code</Label>
              <Input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="6-digit authenticator code"
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending || loading}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
