"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Ban, ShieldAlert, ShieldOff, Lock, Unlock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { UserDetail } from "./user-tabs-types";
import { banUser, unbanUser, lockUser, unlockUser } from "../actions";
import { moveBalanceToVault } from "./actions";
import { DeleteUserDialog, WipeAccountButton, EditIdentityButton } from "./user-tabs-dialogs";

/**
 * Moderation toolbar — the action buttons that used to live at the top of
 * the Moderation section. Rendered in the hero of the user detail page
 * now so admins don't have to scroll to Account → Moderation to act.
 *
 * NOTE: EditIdentityButton is NOT included here — it lives in the hero
 * directly, to the LEFT of ChangeRole, per user request.
 */
export function UserAdminActions({
  user,
  availableBalance,
}: {
  user: UserDetail["user"];
  // Used by the "To vault" button so the confirm dialog can echo the
  // exact amount that's about to be parked. Also drives the disabled
  // state when the user has $0 spendable. Optional — older callers
  // that don't have balance data just hide the button.
  availableBalance?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {user.isBanned ? (
        <UnbanButton userId={user.id} />
      ) : (
        <BanButton userId={user.id} />
      )}
      {user.isLocked ? (
        <UnlockButton userId={user.id} />
      ) : (
        <LockButton userId={user.id} />
      )}
      {availableBalance !== undefined && (
        <MoveToVaultButton
          userId={user.id}
          availableBalance={availableBalance}
        />
      )}
      <DeleteUserDialog user={user} isPending={false} />
      <WipeAccountButton
        userId={user.id}
        displayName={
          user.displayUsername ?? user.username ?? user.email ?? user.id
        }
      />
    </div>
  );
}

export const ModerationSection = React.memo(function ModerationSection({
  user,
  mutes,
}: {
  user: UserDetail["user"];
  mutes: UserDetail["mutes"];
}) {
  return (
    <div className="space-y-6">
      {/* Ban/Lock Metadata */}
      {(user.isBanned || user.isLocked) && (
        <div className="space-y-3">
          {user.isBanned && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-rose-400">Banned</p>
              {user.bannedReason && (
                <p className="text-xs text-muted-foreground">
                  Reason: {user.bannedReason}
                </p>
              )}
              {user.bannedAt && (
                <p className="text-xs text-muted-foreground">
                  Date: {formatDateTime(user.bannedAt)}
                </p>
              )}
              {user.bannedBy && (
                <p className="text-xs text-muted-foreground">
                  By: {user.bannedBy}
                </p>
              )}
            </div>
          )}
          {user.isLocked && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-yellow-400">Locked</p>
              {user.lockedReason && (
                <p className="text-xs text-muted-foreground">
                  Reason: {user.lockedReason}
                </p>
              )}
              {user.lockedAt && (
                <p className="text-xs text-muted-foreground">
                  Date: {formatDateTime(user.lockedAt)}
                </p>
              )}
              {user.lockedBy && (
                <p className="text-xs text-muted-foreground">
                  By: {user.lockedBy}
                </p>
              )}
              {user.lockedUntil && (
                <p className="text-xs text-muted-foreground">
                  Until: {formatDateTime(user.lockedUntil)}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mute History */}
      {mutes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Mute History ({mutes.length})
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mutes.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-xs">
                    {formatDateTime(m.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">{m.reason ?? "-"}</TableCell>
                  <TableCell className="text-xs">
                    {m.expiresAt ? formatDateTime(m.expiresAt) : "Permanent"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        m.unmutedAt
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                      }
                    >
                      {m.unmutedAt ? "Unmuted" : "Active"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {mutes.length === 0 && !user.isBanned && !user.isLocked && (
        <p className="text-sm text-muted-foreground">No moderation history</p>
      )}
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────
//  Inline action buttons — ban / unban / lock / unlock
// ───────────────────────────────────────────────────────────────────
//
// These wrap the existing server actions with a confirm dialog + reason
// field. The server actions already enforce capability checks, so the
// client doesn't need to gate — any user without permission gets an
// error toast when they submit.

function BanButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!reason.trim()) {
      toast.error("Reason required");
      return;
    }
    startTransition(async () => {
      try {
        await banUser(userId, reason.trim());
        toast.success("User banned");
        setOpen(false);
        setReason("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ban failed");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
        onClick={() => setOpen(true)}
      >
        <Ban className="size-3.5" /> Ban
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ban user</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Reason</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this user being banned?"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isPending}
            onClick={submit}
          >
            {isPending ? "Banning..." : "Confirm ban"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnbanButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await unbanUser(userId);
        toast.success("User unbanned");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unban failed");
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <ShieldOff className="size-3.5" /> Unban
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unban user?</AlertDialogTitle>
          <AlertDialogDescription>
            They will be able to log in and play again immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={isPending}>
            {isPending ? "Unbanning..." : "Unban"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LockButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!reason.trim()) {
      toast.error("Reason required");
      return;
    }
    startTransition(async () => {
      try {
        await lockUser(userId, reason.trim());
        toast.success("User locked");
        setOpen(false);
        setReason("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Lock failed");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-amber-500/40 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
        onClick={() => setOpen(true)}
      >
        <Lock className="size-3.5" /> Lock
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Lock user account</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Reason</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why lock this account?"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={isPending}
            onClick={submit}
            className="gap-1.5"
          >
            <ShieldAlert className="size-3.5" />
            {isPending ? "Locking..." : "Lock account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnlockButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await unlockUser(userId);
        toast.success("User unlocked");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unlock failed");
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Unlock className="size-3.5" /> Unlock
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unlock user?</AlertDialogTitle>
          <AlertDialogDescription>
            The account will be accessible again immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={isPending}>
            {isPending ? "Unlocking..." : "Unlock"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Move balance → vault (instant, no unlock window)
// ---------------------------------------------------------------------------

function MoveToVaultButton({
  userId,
  availableBalance,
}: {
  userId: string;
  availableBalance: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Disable when there's nothing spendable to move — the action would
  // fail server-side with "Available balance is already 0" anyway.
  const disabled = availableBalance <= 0;

  function submit() {
    startTransition(async () => {
      const result = await moveBalanceToVault(userId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Moved ${formatCurrency(result.movedAmount)} to vault`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            title={
              disabled
                ? "Available balance is $0"
                : "Move entire spendable balance to vault (no unlock time)"
            }
          />
        }
      >
        <Archive className="size-3.5" />
        <span>To vault</span>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Archive className="size-4 text-primary" />
            Move balance to vault?
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This moves the user&apos;s entire spendable balance{" "}
              <span className="font-semibold tabular-nums text-foreground">
                ({formatCurrency(availableBalance)})
              </span>{" "}
              into their vault (locked balance) instantly.
            </span>
            <span className="block">
              <strong>No unlock time</strong> — the lock has no scheduled
              expiry, so the user can withdraw it back themselves whenever.
              Total balance is unchanged. The movement is recorded in the
              ledger as a <code className="font-mono text-xs">vault_lock</code>{" "}
              event and audit-logged.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={isPending}>
            {isPending ? "Moving..." : "Move to vault"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
