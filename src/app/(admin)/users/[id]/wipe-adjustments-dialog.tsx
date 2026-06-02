"use client";

import { useState, useEffect, useMemo, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Eraser,
  Loader2,
  ShieldAlert,
  Search,
  RotateCcw,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  listWipeableAdjustments,
  listBalanceAdjustmentWipes,
  wipeBalanceAdjustments,
  restoreBalanceAdjustmentWipe,
  type WipeableAdjustment,
  type RecoverableWipe,
} from "./wipe-adjustments-actions";

// House-POV color helper (CLAUDE.md): a balance ADJUSTMENT that credits the
// user (amount > 0) is money the house gave them → the user gained → ROSE.
// A debit (amount < 0, house took back) → the user lost → EMERALD. Wiping a
// rose (positive) row REDUCES what we owe the user → good for the house.
function houseAmountClass(amount: number): string {
  if (amount > 0) return "text-rose-500 dark:text-rose-400";
  if (amount < 0) return "text-emerald-500 dark:text-emerald-400";
  return "text-muted-foreground";
}

function signedCurrency(amount: number): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(amount))}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Entry button — lives in the user-detail moderation toolbar next to Wipe /
// Delete. Opens the preview+select dialog. Admin-gated upstream (the caller
// only renders it for admins / __can_wipe_accounts holders); the server
// action re-checks regardless.
// ───────────────────────────────────────────────────────────────────────────

export function WipeAdjustmentsButton({
  userId,
}: {
  userId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-rose-500/40 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500 dark:text-rose-400"
        onClick={() => setOpen(true)}
      >
        <Eraser className="size-3.5" />
        Wipe Adjustments
      </Button>
      <WipeAdjustmentsDialog userId={userId} open={open} onOpenChange={setOpen} />
    </>
  );
}

type Phase = "select" | "confirm";

function WipeAdjustmentsDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<WipeableAdjustment[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState<Phase>("select");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  // Lazy-load the wipeable rows when the dialog opens (hidden-component rule
  // — never preload on page render). Reset everything on close.
  useEffect(() => {
    if (!open) {
      setRows([]);
      setSelected(new Set());
      setSearch("");
      setPhase("select");
      setTotpCode("");
      setLoadError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listWipeableAdjustments(userId)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setLoadError(res.error);
          setRows([]);
          return;
        }
        setRows(res.rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load adjustments");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.reason.toLowerCase().includes(q));
  }, [rows, search]);

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  const totalSelected = useMemo(
    () => selectedRows.reduce((acc, r) => acc + r.amount, 0),
    [selectedRows],
  );

  const filteredAllSelected =
    filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const filteredSomeSelected =
    filtered.some((r) => selected.has(r.id)) && !filteredAllSelected;

  const toggleOne = useCallback((id: string, v: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Select-all toggles only the CURRENTLY FILTERED rows — this is the
  // mechanism for "bulk-select content-tagged ones": filter by reason, then
  // tick the header box.
  const toggleAllFiltered = useCallback(
    (v: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of filtered) {
          if (v) next.add(r.id);
          else next.delete(r.id);
        }
        return next;
      });
    },
    [filtered],
  );

  function handleWipe() {
    if (selected.size === 0) {
      toast.error("Select at least one adjustment to wipe");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const res = await wipeBalanceAdjustments({
          userId,
          ledgerIds: Array.from(selected),
          totpCode: totpCode.trim(),
        });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(
          `Wiped ${res.deletedCount} adjustment${res.deletedCount === 1 ? "" : "s"} · ${signedCurrency(-res.totalRemoved)} balance`,
        );
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to wipe adjustments");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eraser className="size-4 text-rose-500" />
            {phase === "select"
              ? "Wipe Content Balance Adjustments"
              : "Confirm Wipe"}
          </DialogTitle>
          <DialogDescription>
            {phase === "select" ? (
              <>
                Select the admin balance adjustments to remove. Only{" "}
                <span className="font-medium text-foreground">
                  “Admin adjustment:”
                </span>{" "}
                ledger rows are listed — deposits, withdrawals, manual
                withdrawals, gaming, and affiliate/creator history are never
                touched. Selected rows are hard-deleted (snapshotted first, so
                it’s recoverable) and the balance is reduced by the summed
                amount.
              </>
            ) : (
              <>Review the batch below, then enter your 2FA code to confirm.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" ? (
          <div className="space-y-3">
            {/* Search / filter by reason */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by reason (e.g. Streamer, Giveaway, Content)…"
                className="pl-8"
                disabled={loading || rows.length === 0}
              />
            </div>

            {/* Select-all (filtered) header */}
            {!loading && !loadError && rows.length > 0 && (
              <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={filteredAllSelected}
                  indeterminate={filteredSomeSelected}
                  onCheckedChange={(v) => toggleAllFiltered(v)}
                  aria-label="Select all filtered adjustments"
                />
                <span>
                  Select all{search.trim() ? " matching" : ""} (
                  {filtered.length})
                </span>
              </label>
            )}

            {/* Rows */}
            <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading adjustments…
                </div>
              ) : loadError ? (
                <div className="py-10 text-center text-sm text-rose-500">
                  {loadError}
                </div>
              ) : rows.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  This user has no admin balance adjustments to wipe.
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  No adjustments match “{search}”.
                </div>
              ) : (
                filtered.map((r) => {
                  const isChecked = selected.has(r.id);
                  return (
                    <label
                      key={r.id}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer transition-colors hover:bg-muted/40",
                        isChecked && "bg-rose-500/[0.06]",
                      )}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(v) => toggleOne(r.id, v)}
                        aria-label={`Select adjustment ${r.reason}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-foreground">
                          {r.reason || "(no reason)"}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatDateTime(r.createdAt)} ·{" "}
                          {formatRelative(r.createdAt)}
                        </div>
                      </div>
                      <div
                        className={cn(
                          "shrink-0 tabular-nums font-semibold",
                          houseAmountClass(r.amount),
                        )}
                      >
                        {signedCurrency(r.amount)}
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            {/* Running totals */}
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">
                  {selected.size}
                </span>{" "}
                selected
              </span>
              <span className="text-muted-foreground">
                Total to remove:{" "}
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    houseAmountClass(totalSelected),
                  )}
                >
                  {signedCurrency(totalSelected)}
                </span>
              </span>
            </div>
          </div>
        ) : (
          // ── Confirm phase ──────────────────────────────────────────────
          <div className="space-y-4">
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 space-y-2 text-sm">
              <p className="flex items-center gap-2 font-medium text-rose-400">
                <ShieldAlert className="size-4" />
                You are about to permanently delete {selected.size} balance
                adjustment{selected.size === 1 ? "" : "s"}.
              </p>
              <p className="text-muted-foreground">
                The user’s balance will be reduced by{" "}
                <span className="font-semibold text-foreground tabular-nums">
                  {signedCurrency(totalSelected)}
                </span>
                . The deleted rows are snapshotted first, so this batch can be
                restored later. Remaining ledger rows keep their original
                balance_before/after (not rewritten) — only the current
                balance is corrected.
              </p>
            </div>

            {/* Compact recap of the selected rows */}
            <div className="max-h-44 overflow-y-auto rounded-md border divide-y">
              {selectedRows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between px-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {r.reason || "(no reason)"} ·{" "}
                    <span className="text-foreground/70">
                      {formatDateTime(r.createdAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "ml-2 shrink-0 tabular-nums font-semibold",
                      houseAmountClass(r.amount),
                    )}
                  >
                    {signedCurrency(r.amount)}
                  </span>
                </div>
              ))}
            </div>

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
                autoFocus
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {phase === "select" ? (
            <Button
              size="sm"
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={selected.size === 0 || loading}
              onClick={() => setPhase("confirm")}
            >
              Review {selected.size > 0 ? `(${selected.size})` : ""}
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setPhase("select")}
                disabled={isPending}
              >
                Back
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="w-full sm:w-auto"
                onClick={handleWipe}
                disabled={isPending || !totpCode.trim()}
              >
                {isPending ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Eraser className="mr-1.5 size-3.5" />
                )}
                {isPending ? "Wiping…" : "Wipe Adjustments"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Recoverable wipes strip — shown in the user-detail Moderation tab when this
// user has one or more wipe batches. Self-fetching (lazy: the Moderation tab
// only mounts when the Account tab is opened, so this never loads on the
// initial page render). Renders nothing while loading or when empty. Each
// non-restored batch can be restored (re-add rows + balance) behind 2FA;
// after a restore it refetches locally so the status flips in place.
// ───────────────────────────────────────────────────────────────────────────

export function RecoverableWipesStrip({ userId }: { userId: string }) {
  const [wipes, setWipes] = useState<RecoverableWipe[] | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    listBalanceAdjustmentWipes(userId)
      .then((res) => {
        if (!cancelled) setWipes(res);
      })
      .catch(() => {
        if (!cancelled) setWipes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => load(), [load]);

  // Nothing to show until loaded, and stay invisible when the user has no
  // wipe history (the common case) so the tab isn't cluttered.
  if (!wipes || wipes.length === 0) return null;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.04] p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-500 dark:text-amber-400">
        <RotateCcw className="size-3.5" />
        Recoverable adjustment wipes
      </div>
      <div className="space-y-1.5">
        {wipes.map((w) => (
          <div
            key={w.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/60 px-3 py-2 text-xs"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="text-foreground">
                <span className="font-semibold tabular-nums">
                  {w.adjustmentCount}
                </span>{" "}
                adjustment{w.adjustmentCount === 1 ? "" : "s"} ·{" "}
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    houseAmountClass(w.totalAmount),
                  )}
                >
                  {signedCurrency(w.totalAmount)}
                </span>{" "}
                <span className="text-muted-foreground">
                  ({formatCurrency(w.balanceBefore)} → {formatCurrency(w.balanceAfter)})
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {formatRelative(w.wipedAt)} by {w.wipedByLabel}
              </div>
            </div>
            {w.restoredAt ? (
              <Badge
                variant="outline"
                className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              >
                Restored {formatRelative(w.restoredAt)}
                {w.restoredByLabel ? ` · ${w.restoredByLabel}` : ""}
              </Badge>
            ) : (
              <RestoreWipeButton
                wipeId={w.id}
                count={w.adjustmentCount}
                total={w.totalAmount}
                onRestored={load}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RestoreWipeButton({
  wipeId,
  count,
  total,
  onRestored,
}: {
  wipeId: string;
  count: number;
  total: number;
  onRestored: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleRestore() {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const res = await restoreBalanceAdjustmentWipe(wipeId, totpCode.trim());
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success("Adjustments restored");
        setOpen(false);
        setTotpCode("");
        // Refetch the strip so the batch flips to "Restored" in place, and
        // re-run the server tree so the balance card / tx list update.
        onRestored();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to restore");
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setTotpCode("");
      }}
    >
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" />
        }
      >
        <RotateCcw className="size-3" />
        Restore
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RotateCcw className="size-4 text-amber-500" />
            Restore {count} adjustment{count === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This re-inserts the deleted ledger rows and adds{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {signedCurrency(total)}
            </span>{" "}
            back to the user’s balance. Enter your 2FA code to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
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
            onClick={handleRestore}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto"
          >
            {isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 size-3.5" />
            )}
            {isPending ? "Restoring…" : "Restore"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
