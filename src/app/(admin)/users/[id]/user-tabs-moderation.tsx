"use client";

import React, { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Archive, Ban, ShieldAlert, ShieldBan, ShieldCheck, ShieldOff, Lock, Unlock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import type { UserDetail } from "./user-tabs-types";
import { banUser, unbanUser, lockUser, unlockUser } from "../actions";
import { moveBalanceToVault } from "./actions";

/**
 * Moderation toolbar — the action buttons that used to live at the top of
 * the Moderation section. Rendered in the hero of the user detail page
 * now so admins don't have to scroll to Account → Moderation to act.
 *
 * Each button is gated on the relevant capability so non-admins without
 * the matching grant don't see ANY trigger for an action they can't
 * perform — UI signaling matches the server-side gate. Defence-in-depth:
 * the actions still re-check on the server, the gate here just keeps
 * support staff from seeing dead buttons.
 */
export function UserAdminActions({
  user,
  availableBalance,
  lockedBalance,
  unlockAt,
  isAdmin,
  capabilities,
}: {
  user: UserDetail["user"];
  // Used by the "To vault" button so the confirm dialog can echo the
  // exact amount that's about to be parked. Also drives the disabled
  // state when the user has $0 spendable. Optional — older callers
  // that don't have balance data just hide the button.
  availableBalance?: number;
  // Surfaced to the vault dialog so the existing-vault warning + the
  // "clear unlock window" checkbox can flag the right state.
  lockedBalance?: number;
  unlockAt?: string | null;
  // Admin or capability-resolved permission flags. Without these the
  // toolbar refuses to render any of the moderation buttons.
  isAdmin: boolean;
  capabilities: UserDetail["capabilities"];
}) {
  const canBan = isAdmin || capabilities.canBanUsers;
  const canLock = isAdmin || capabilities.canLockUsers;
  const canMoveToVault = isAdmin || capabilities.canAdjustBalance;

  // Optimistic ban/lock state — the server actions flush NARROW cache tags
  // only (no revalidatePath, which re-rendered the whole route and caused
  // the scroll jump), so the button flip can't come from a route re-render
  // anymore. Flip locally the moment the action SUCCEEDS (post-confirm, so
  // no rollback path is needed) and re-sync whenever the tag revalidation
  // streams fresh server truth in — same seed/re-sync semantics as
  // use-toggle-action.ts, which doesn't fit directly here because ban/lock
  // are reason-gated confirm dialogs split across two components.
  const [banned, setBanned] = useState(user.isBanned);
  const [locked, setLocked] = useState(user.isLocked);
  useEffect(() => setBanned(user.isBanned), [user.isBanned]);
  useEffect(() => setLocked(user.isLocked), [user.isLocked]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canBan &&
        (banned ? (
          <UnbanButton userId={user.id} onSuccess={() => setBanned(false)} />
        ) : (
          <BanButton userId={user.id} onSuccess={() => setBanned(true)} />
        ))}
      {canLock &&
        (locked ? (
          <UnlockButton userId={user.id} onSuccess={() => setLocked(false)} />
        ) : (
          <LockButton userId={user.id} onSuccess={() => setLocked(true)} />
        ))}
      {canMoveToVault && availableBalance !== undefined && (
        <MoveToVaultButton
          userId={user.id}
          availableBalance={availableBalance}
          lockedBalance={lockedBalance ?? 0}
          unlockAt={unlockAt ?? null}
        />
      )}
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
  // Self-exclusion (responsible-gambling) live state. USER-initiated on the
  // game platform — DISPLAY-ONLY here (no admin endpoint imposes/lifts it).
  // The flag is sticky, so we derive active-vs-expired from the `until`
  // timestamp: a set flag with `until` in the past = the window has lapsed.
  const selfExcludedActive =
    user.isSelfExcluded &&
    (!user.selfExcludedUntil ||
      new Date(user.selfExcludedUntil).getTime() > Date.now());

  return (
    <div className="space-y-4">
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

      {/* Self-Exclusion (responsible gambling) — USER-initiated on the game
          platform, DISPLAY-ONLY here (there is no admin endpoint to impose or
          lift it). Shown whenever the flag is set, regardless of whether the
          window is still open: ACTIVE (window open / open-ended) means the user
          is CURRENTLY restricted on the game platform — the betting/withdrawal
          routes 403 for them; EXPIRED means the flag is still set but the
          window has lapsed (no longer restricted). Same visual vocabulary as
          the Ban/Lock metadata cards above. */}
      {user.isSelfExcluded && (
        <div
          className={
            selfExcludedActive
              ? "rounded-md border border-rose-500/30 bg-rose-500/5 p-3 space-y-2"
              : "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2"
          }
        >
          <div className="flex items-center gap-2">
            <ShieldBan
              className={
                selfExcludedActive
                  ? "size-4 text-rose-400"
                  : "size-4 text-amber-400"
              }
            />
            <p
              className={
                selfExcludedActive
                  ? "text-sm font-medium text-rose-400"
                  : "text-sm font-medium text-amber-400"
              }
            >
              Self-Excluded
            </p>
            <Badge
              variant="outline"
              className={
                selfExcludedActive
                  ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
              }
            >
              {selfExcludedActive ? "Active" : "Expired"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {selfExcludedActive
              ? "User-initiated responsible-gambling exclusion. The user is currently restricted on the game platform (betting & withdrawal routes are blocked for them)."
              : "User-initiated responsible-gambling exclusion. The exclusion window has lapsed — the user is no longer restricted, though the flag remains set on their account."}
          </p>
          {user.selfExcludedReason && (
            <p className="text-xs text-muted-foreground">
              Reason: {user.selfExcludedReason}
            </p>
          )}
          {user.selfExcludedAt && (
            <p className="text-xs text-muted-foreground">
              Since: {formatDateTime(user.selfExcludedAt)} (
              {formatRelative(user.selfExcludedAt)})
            </p>
          )}
          {user.selfExcludedUntil ? (
            <p className="text-xs text-muted-foreground">
              {selfExcludedActive ? "Lifts" : "Lifted"}:{" "}
              {formatDateTime(user.selfExcludedUntil)} (
              {formatRelative(user.selfExcludedUntil)})
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No end date — open-ended exclusion.
            </p>
          )}
          {/* DISPLAY-ONLY: no impose/lift control. Self-exclusion is set by the
              user on the game platform; there is no admin endpoint for it. */}
          <p className="text-[11px] italic text-muted-foreground/70">
            Display only — self-exclusion is managed by the user on the game
            platform; it cannot be imposed or lifted from the admin.
          </p>
        </div>
      )}

      {/* Mute History */}
      {mutes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">
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

      {mutes.length === 0 &&
        !user.isBanned &&
        !user.isLocked &&
        !user.isSelfExcluded && (
        <EmptyState
          icon={ShieldCheck}
          title="No moderation history"
          description="This user has never been banned, locked, or muted."
          compact
        />
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

function BanButton({
  userId,
  onSuccess,
}: {
  userId: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!reason.trim()) {
      toast.error("Reason required");
      return;
    }
    startTransition(async () => {
      // ServerActionResult — branch on result.success instead of try/catch.
      const result = await banUser(userId, reason.trim());
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("User banned");
      setOpen(false);
      setReason("");
      // No `router.refresh()` and no route re-render — the action flushes
      // narrow tags only; `onSuccess` flips the optimistic Ban→Unban state
      // in UserAdminActions instantly, server truth re-syncs via the tags.
      onSuccess();
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

function UnbanButton({
  userId,
  onSuccess,
}: {
  userId: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await unbanUser(userId);
        toast.success("User unbanned");
        setOpen(false);
        // Optimistic Unban→Ban flip — see BanButton (narrow tags, no
        // route re-render).
        onSuccess();
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

function LockButton({
  userId,
  onSuccess,
}: {
  userId: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!reason.trim()) {
      toast.error("Reason required");
      return;
    }
    startTransition(async () => {
      // ServerActionResult — branch on result.success instead of try/catch.
      const result = await lockUser(userId, reason.trim());
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("User locked");
      setOpen(false);
      setReason("");
      // Optimistic Lock→Unlock flip — see BanButton (narrow tags, no
      // route re-render).
      onSuccess();
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

function UnlockButton({
  userId,
  onSuccess,
}: {
  userId: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        await unlockUser(userId);
        toast.success("User unlocked");
        setOpen(false);
        // Optimistic Unlock→Lock flip — see BanButton (narrow tags, no
        // route re-render).
        onSuccess();
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
  lockedBalance,
  unlockAt,
}: {
  userId: string;
  availableBalance: number;
  // Surfaced so the dialog can warn the admin that an existing vault
  // pool is about to be merged + an existing unlock window cleared.
  lockedBalance: number;
  unlockAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  // The "I understand" checkbox is only required when there's actual
  // existing vault state that this action will overwrite; empty state
  // (no locked balance and no unlock window) skips the gate.
  const [acknowledged, setAcknowledged] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Disable when there's nothing spendable to move — the action would
  // fail server-side with "Available balance is already 0" anyway.
  const disabled = availableBalance <= 0;
  const hasExistingVaultState = lockedBalance > 0 || unlockAt !== null;

  // Reset the acknowledgement on close so reopening the dialog requires
  // the admin to re-tick the checkbox — prevents accidental confirm on
  // a stale state if the user navigated away and back.
  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) setAcknowledged(false);
  }

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
      setAcknowledged(false);
      // No `router.refresh()` — the moveBalanceToVault server action already
      // revalidates the route (this move re-prices available/locked balance,
      // P&L and vault surfaces across the page, so it keeps the broad
      // revalidate). A client refresh on top is a redundant second refetch.
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
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
        {hasExistingVaultState && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm text-foreground">
              <strong>Existing vault:</strong>{" "}
              <span className="font-semibold tabular-nums">
                {formatCurrency(lockedBalance)}
              </span>
              {unlockAt && (
                <>
                  {" · unlocks "}
                  <span className="tabular-nums">
                    {formatDateTime(unlockAt)}
                  </span>
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              This will merge{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {formatCurrency(availableBalance)}
              </span>{" "}
              (available) into the existing vault and clear the unlock
              window — both pools become unlock-anytime.
            </p>
            <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5"
                disabled={isPending}
              />
              <span>I understand this clears the unlock window.</span>
            </label>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={submit}
            disabled={
              isPending || (hasExistingVaultState && !acknowledged)
            }
          >
            {isPending ? "Moving..." : "Move to vault"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
