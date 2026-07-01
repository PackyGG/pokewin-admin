"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Ticket, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { InlineError } from "@/components/entity-surface/inline-error";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  deleteUserVoucher,
  getUserVouchers,
  type UserVoucherRow,
} from "./actions";
import {
  AbuserTagToggles,
  applyAbuserTags,
  useAbuserTags,
} from "./abuser-tag-toggles";

const VOUCHER_DELETE_MIN_REASON_CHARS = 20;

const ORIGIN_LABELS: Record<string, string> = {
  exchange_excess_to_voucher: "Exchange excess",
  battle_excess_to_voucher: "Battle excess",
  pack_borrow_to_voucher: "Pack borrow",
  creator_fill_conversion: "Creator fill",
  creator_multiplier_payout: "Creator multiplier",
  upgrader_excess_to_voucher: "Upgrader excess",
};

function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin.replace(/_/g, " ");
}

/**
 * Unclaimed vouchers a user is holding — rendered in the Inventory tab next
 * to their cards so "current holdings" reflects ALL held value (a voucher is
 * held value just like a card). Loads on mount via the `getUserVouchers`
 * server action; hidden entirely when the user has none.
 */
export function UserVouchersPanel({
  userId,
  canRemove = false,
}: {
  userId: string;
  /** Same gate as Adjust Balance — admin or __can_adjust_balance. */
  canRemove?: boolean;
}) {
  const [vouchers, setVouchers] = useState<UserVoucherRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  // "Fetch failed" is NOT the same as "no vouchers" — the old
  // `.catch(() => setVouchers([]))` self-hid the panel on every failure, so
  // a broken feed looked identical to a voucher-less user. Failures now
  // render a visible compact error with a retry.
  const [failed, setFailed] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<UserVoucherRow | null>(null);

  function load() {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    getUserVouchers(userId)
      .then((rows) => {
        if (!cancelled) setVouchers(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(() => {
    const cleanup = load();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Hide the section entirely when there's nothing to show (and we're done
  // loading) — keeps the Inventory tab clean for the common no-voucher case.
  // Self-hide applies ONLY to a confirmed-empty success, never to a failure.
  if (!loading && !failed && (!vouchers || vouchers.length === 0)) return null;

  if (!loading && failed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Ticket className="size-4" />
            Vouchers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <InlineError
            compact
            title="Couldn't load vouchers"
            hint="This is a load failure, not an empty list."
            onRetry={() => load()}
          />
        </CardContent>
      </Card>
    );
  }

  const total = (vouchers ?? []).reduce((a, v) => a + v.value, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Ticket className="size-4" />
          Vouchers
          {vouchers && vouchers.length > 0 && (
            <span className="text-muted-foreground">
              — {vouchers.length} ·{" "}
              <span className="tabular-nums">{formatCurrency(total)}</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !vouchers || vouchers.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="No vouchers"
            description="This user has no unclaimed vouchers."
            compact
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {vouchers.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {originLabel(v.origin)}
                    </Badge>
                  </div>
                  {v.description ? (
                    <p
                      className="mt-0.5 truncate text-xs text-muted-foreground"
                      title={v.description}
                    >
                      {v.description}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {formatRelative(v.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(v.value)}
                  </span>
                  {canRemove && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon"
                      className="size-7"
                      aria-label="Remove voucher"
                      onClick={() => setRemoveTarget(v)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {removeTarget && (
        <VoucherRemoveDialog
          userId={userId}
          voucher={removeTarget}
          open={Boolean(removeTarget)}
          onOpenChange={(o) => {
            if (!o) setRemoveTarget(null);
          }}
          onRemoved={() => load()}
        />
      )}
    </Card>
  );
}

function VoucherRemoveDialog({
  userId,
  voucher,
  open,
  onOpenChange,
  onRemoved,
}: {
  userId: string;
  voucher: UserVoucherRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const abuser = useAbuserTags();
  const [isPending, startTransition] = useTransition();

  function handleClose(next: boolean) {
    if (isPending) return;
    if (!next) {
      setReason("");
      setTotpCode("");
      abuser.reset();
    }
    onOpenChange(next);
  }

  function handleRemove() {
    const trimmed = reason.trim();
    if (trimmed.length < VOUCHER_DELETE_MIN_REASON_CHARS) {
      toast.error(
        `Reason must be at least ${VOUCHER_DELETE_MIN_REASON_CHARS} characters`,
      );
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const result = await deleteUserVoucher({
          userId,
          voucherId: voucher.id,
          reason: trimmed,
          totpCode: totpCode.trim(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Voucher removed");
        await applyAbuserTags(userId, abuser.selected);
        setReason("");
        setTotpCode("");
        abuser.reset();
        onOpenChange(false);
        // The panel re-fetches its own voucher list (onRemoved -> load()), so
        // the removed row + total update in place. No `router.refresh()` — a
        // full-tree refresh here re-suspends the page and loses scroll. The
        // `deleteUserVoucher` action busts the per-user cache tag, so any other
        // holdings surface reconciles on the next render / 60s AutoRefresh.
        onRemoved?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to remove voucher",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove voucher</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <p className="font-medium tabular-nums">
              {formatCurrency(voucher.value)}
            </p>
            <p className="text-xs text-muted-foreground">{voucher.origin}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voucher-remove-reason">Reason</Label>
            <Textarea
              id="voucher-remove-reason"
              placeholder={`Why is this voucher being removed? (min ${VOUCHER_DELETE_MIN_REASON_CHARS} characters)`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              disabled={isPending}
            />
            <p className="text-[10px] text-muted-foreground">
              {reason.trim().length}/{VOUCHER_DELETE_MIN_REASON_CHARS} minimum.
              Recorded in the user&apos;s transactions box.
            </p>
          </div>
          <AbuserTagToggles state={abuser} disabled={isPending} />
          <div className="space-y-1.5">
            <Label htmlFor="voucher-remove-2fa">2FA code</Label>
            <Input
              id="voucher-remove-2fa"
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
            onClick={handleRemove}
            disabled={isPending}
            className="gap-1.5"
          >
            <Trash2 className="size-4" />
            {isPending ? "Removing…" : "Remove voucher"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
