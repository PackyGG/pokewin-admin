"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Trash2,
  UserX,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { Spinner } from "@/components/ux";

import type { ExcludedUserRow } from "@/lib/excluded-users/fetch";

import {
  addExcludedUser,
  removeExcludedUser,
  setExcludedUserBalanceV2,
} from "./actions";
import {
  unlockUserWithdrawals,
  relockUserWithdrawals,
} from "@/app/(admin)/withdrawals/lock-actions";

/**
 * Client wrapper for the excluded-users management page. Initial rows
 * come from the server component; mutations go through server actions
 * that revalidate the route, and router.refresh() re-pulls the list.
 *
 * Add and remove both use controlled state — the add form sits above
 * the table and stays open across multiple inserts so an admin can
 * paste several IDs in a row without re-opening anything.
 */
export function ExcludedUsersClient({
  initial,
  balanceV2TableReady,
  canManageWithdrawalLock,
}: {
  initial: ExcludedUserRow[];
  // False if the underlying admin_excluded_user_balance_v2 table hasn't
  // been provisioned yet (pre-migration). The UI surfaces an amber hint
  // banner above the table; the cells fall back to "—" and Save returns
  // a clean error instead of crashing.
  balanceV2TableReady: boolean;
  // True only for motha (the root owner). Gates the withdrawal lock/unlock
  // toggle — non-motha owners see the locked/unlocked STATE but no control.
  // The server actions enforce the same motha-only check independently.
  canManageWithdrawalLock: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");

  function handleAdd() {
    const trimmed = userId.trim();
    if (!trimmed) {
      toast.error("Paste a user ID first");
      return;
    }
    startTransition(async () => {
      try {
        const result = await addExcludedUser({
          userId: trimmed,
          reason: reason.trim() || undefined,
        });
        // Validation failures come back as a structured result (HTTP 200)
        // rather than a thrown 500 — surface the message as an error toast.
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        if (result.inserted === 0) {
          toast.info("That user ID is already excluded");
        } else {
          toast.success("User excluded");
          // Only clear the inputs on a successful insert so a duplicate
          // submission doesn't lose what the admin typed.
          setUserId("");
          setReason("");
        }
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add");
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Add form — sits above the table so it's the first thing the
          admin sees. Stays open across inserts (no modal) since this
          flow is typically multiple IDs in a row. */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">Add a user to the blacklist</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="excluded-user-id" className="text-xs">
              User ID
            </Label>
            <Input
              id="excluded-user-id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="R3cqeAyDdNQNbltwnQQJuJUHiqjiNw98"
              className="font-mono text-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="excluded-user-reason" className="text-xs">
              Reason{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="excluded-user-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Internal test account / hand-picked outlier"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
          </div>
          <Button onClick={handleAdd} disabled={isPending} size="sm">
            {isPending ? (
              <Spinner size={16} className="text-current" />
            ) : (
              <Plus className="size-4" />
            )}
            {isPending ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>

      {/* Migration-missing hint — only when the Balance 2.0 admin DB
          table doesn't exist yet. The page still renders normally; the
          Balance 2.0 cells just show "—" and save attempts get a clean
          error pointing at the migration to apply. */}
      {!balanceV2TableReady && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                Balance 2.0 storage not provisioned.
              </span>{" "}
              Apply{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                prisma/admin/migrations/20260605000000_add_excluded_user_balance_v2/migration.sql
              </code>{" "}
              against the admin DB to enable editing. Reads will fall back
              to <span className="font-mono">—</span> until the table
              exists.
            </p>
          </div>
        </div>
      )}

      {/* Existing blacklist */}
      {initial.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={UserX}
            title="No excluded users yet"
            description="Excluded user IDs are dropped from dashboard, analytics, and PnL aggregates."
            compact
          />
        </div>
      ) : (
        <>
          {/* Desktop table (>=md). */}
          <div className="hidden rounded-xl border bg-card overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User ID</TableHead>
                  <TableHead className="text-right">Total Deposited</TableHead>
                  <TableHead className="text-right">Balance 2.0</TableHead>
                  <TableHead>Withdrawals</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Excluded by</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-[80px] text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {initial.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="font-mono text-xs">
                      {row.userId}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {row.totalDeposited > 0 ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {formatCurrency(row.totalDeposited)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <BalanceV2Cell
                        userId={row.userId}
                        value={row.balanceV2}
                        tableReady={balanceV2TableReady}
                      />
                    </TableCell>
                    <TableCell>
                      <WithdrawalLockControl
                        userId={row.userId}
                        unlocked={row.withdrawalUnlocked}
                        canManage={canManageWithdrawalLock}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.reason ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.excludedByUsername}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RemoveButton userId={row.userId} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile card list (<md) — the 6-col table overflows at
              360px (the user ID alone is 32 mono chars). */}
          <div className="space-y-2 md:hidden">
            {initial.map((row) => (
              <div
                key={row.userId}
                className="rounded-xl border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-all font-mono text-xs">
                    {row.userId}
                  </span>
                  <RemoveButton userId={row.userId} className="size-9" />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">Total deposited</span>
                  {row.totalDeposited > 0 ? (
                    <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(row.totalDeposited)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">Balance 2.0</span>
                  <BalanceV2Cell
                    userId={row.userId}
                    value={row.balanceV2}
                    tableReady={balanceV2TableReady}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">Withdrawals</span>
                  <WithdrawalLockControl
                    userId={row.userId}
                    unlocked={row.withdrawalUnlocked}
                    canManage={canManageWithdrawalLock}
                  />
                </div>
                {row.reason && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.reason}
                  </p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Excluded by {row.excludedByUsername} ·{" "}
                  {formatDateTime(row.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RemoveButton({
  userId,
  className,
}: {
  userId: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleRemove() {
    startTransition(async () => {
      try {
        const result = await removeExcludedUser(userId);
        if (!result.ok) {
          toast.error(result.error);
          setOpen(false);
          return;
        }
        toast.success("User un-excluded — metrics will include their activity again");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove");
        setOpen(false);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            disabled={isPending}
            className={cn(
              "size-8 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400",
              className,
            )}
            aria-label="Remove from blacklist"
          />
        }
      >
        <Trash2 className="size-4" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove from blacklist?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-xs">{userId}</span>
            <br />
            Their activity will start counting toward dashboard / analytics
            / PnL aggregates again immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRemove} disabled={isPending}>
            {isPending && <Spinner size={14} className="text-current" />}
            {isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Editable Balance 2.0 cell. Click-to-edit pattern: shows the current
 * value formatted via `formatCurrency` (so it matches the Total
 * Deposited column visually), and clicking the pencil swaps in a tiny
 * inline `<input type="number">` with Save / Cancel buttons.
 *
 * Visual rules:
 *   • Unset value (`null`) → rendered as "—" so the column is
 *     consistent with the Total Deposited / Reason "no data" markers.
 *   • Set value → emerald like the existing money column on this page
 *     (this is an admin-managed annotation, not a P&L number — the
 *     house-POV color rule doesn't apply to a free-form number that
 *     doesn't change the user's actual balance).
 *
 * Pre-migration (`tableReady === false`): rendered as "—" with the
 * edit button hidden, and the migration-missing banner above the
 * table tells the operator why. We don't grey the cell beyond that —
 * the banner is the loud signal.
 */
function BalanceV2Cell({
  userId,
  value,
  tableReady,
}: {
  userId: string;
  value: number | null;
  tableReady: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  // String state mirrors the input element exactly — coercing to number
  // on every keystroke would discard "0." while the user is typing.
  const [draft, setDraft] = useState<string>(
    value !== null ? value.toFixed(2) : "",
  );
  const [isPending, startTransition] = useTransition();

  function startEdit() {
    setDraft(value !== null ? value.toFixed(2) : "");
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft(value !== null ? value.toFixed(2) : "");
  }

  function handleSave() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      toast.error("Enter a number (use 0 to reset to zero)");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Balance 2.0 must be zero or positive");
      return;
    }
    startTransition(async () => {
      try {
        const result = await setExcludedUserBalanceV2({
          userId,
          balanceV2: trimmed,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("Balance 2.0 updated");
        setEditing(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to update Balance 2.0",
        );
      }
    });
  }

  if (editing) {
    return (
      <div className="flex items-center justify-end gap-1">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          disabled={isPending}
          autoFocus
          className="h-7 w-24 text-right font-mono text-xs tabular-nums"
          aria-label="Balance 2.0 value"
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
          onClick={handleSave}
          disabled={isPending}
          aria-label="Save Balance 2.0"
        >
          {isPending ? (
            <Spinner size={12} className="text-current" />
          ) : (
            <Check className="size-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={cancelEdit}
          disabled={isPending}
          aria-label="Cancel"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center justify-end gap-1.5">
      {value !== null ? (
        <span className="font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(value)}
        </span>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">—</span>
      )}
      {tableReady && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={startEdit}
          aria-label="Edit Balance 2.0"
        >
          <Pencil className="size-3" />
        </Button>
      )}
    </div>
  );
}

/**
 * Withdrawal lock/unlock control for one excluded user.
 *
 * Excluded users are withdrawal-LOCKED by default. Shows the current state as
 * a badge (Locked = amber / held; Unlocked = rose because withdrawals can then
 * move money out = house exposure). When `canManage` (motha only), a toggle
 * button flips the per-user unlock override via the motha-only server actions;
 * both actions re-check the motha gate server-side, so a non-motha viewer only
 * ever sees the read-only badge. Each toggle is confirmed to avoid an
 * accidental unlock.
 */
function WithdrawalLockControl({
  userId,
  unlocked,
  canManage,
}: {
  userId: string;
  unlocked: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const badge = unlocked ? (
    <Badge
      variant="outline"
      className="gap-1 border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
    >
      <LockOpen className="size-3" />
      Unlocked
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
    >
      <Lock className="size-3" />
      Locked
    </Badge>
  );

  // Non-motha viewers see the state only — no control.
  if (!canManage) {
    return badge;
  }

  function handleToggle() {
    startTransition(async () => {
      try {
        const result = unlocked
          ? await relockUserWithdrawals(userId)
          : await unlockUserWithdrawals({ userId });
        if (!result.success) {
          toast.error(result.error);
          setOpen(false);
          return;
        }
        toast.success(
          unlocked
            ? "Withdrawals re-locked for this user"
            : "Withdrawals unlocked for this user",
        );
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update lock");
        setOpen(false);
      }
    });
  }

  return (
    <div className="inline-flex items-center gap-2">
      {badge}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={isPending}
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={
                unlocked ? "Re-lock withdrawals" : "Unlock withdrawals"
              }
            />
          }
        >
          {unlocked ? (
            <Lock className="size-3.5" />
          ) : (
            <LockOpen className="size-3.5" />
          )}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {unlocked
                ? "Re-lock withdrawals?"
                : "Unlock withdrawals?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs">{userId}</span>
              <br />
              {unlocked
                ? "Their withdrawals will be blocked again — no admin can process, cancel, ship, complete, or fail them until you unlock again."
                : "Their withdrawals will become processable again by admins. Only you (motha) can undo this."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleToggle} disabled={isPending}>
              {isPending && <Spinner size={14} className="text-current" />}
              {isPending
                ? "Saving…"
                : unlocked
                  ? "Re-lock"
                  : "Unlock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
