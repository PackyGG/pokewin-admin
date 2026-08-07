"use client";

import React, { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Ban,
  Fingerprint,
  Lock,
  Network,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  ShieldOff,
  Unlock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { BAN_REASON_PRESETS } from "@/lib/ban-reasons";
import type { UserDetail } from "./user-tabs-types";
import {
  banUser,
  blockUserIdentifiers,
  unbanUser,
  lockUser,
  unlockUser,
} from "../actions";

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
  isAdmin,
  capabilities,
}: {
  user: UserDetail["user"];
  // Admin or capability-resolved permission flags. Without these the
  // toolbar refuses to render any of the moderation buttons.
  isAdmin: boolean;
  capabilities: UserDetail["capabilities"];
}) {
  const canBan = isAdmin || capabilities.canBanUsers;
  const canLock = isAdmin || capabilities.canLockUsers;

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
      {canBan && (
        <>
          <BlockIdentifierButton userId={user.id} kind="ip" />
          <BlockIdentifierButton userId={user.id} kind="fingerprint" />
        </>
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

// Preset ban reasons so the common cases are a click, not typing — "Custom"
// falls back to the free-text box. Values map to the exact string stored in
// `user.banned_reason`; add more presets here as new categories come up.
const BAN_REASON_OPTIONS: { value: string; label: string }[] = [
  ...BAN_REASON_PRESETS.map((reason) => ({ value: reason, label: reason })),
  { value: "custom", label: "Custom" },
];

function BanButton({
  userId,
  onSuccess,
}: {
  userId: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reasonOption, setReasonOption] = useState<string | null>(null);
  const [customReason, setCustomReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const isCustom = reasonOption === "custom";
  const effectiveReason = isCustom ? customReason.trim() : (reasonOption ?? "");

  function submit() {
    if (!reasonOption) {
      toast.error("Select a reason");
      return;
    }
    if (!effectiveReason) {
      toast.error("Reason required");
      return;
    }
    startTransition(async () => {
      // ServerActionResult — branch on result.success instead of try/catch.
      const result = await banUser(userId, effectiveReason);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const { ipCount, fingerprintCount } = result.data.identifiers;
      toast.success(
        `User banned · ${ipCount} IP${ipCount === 1 ? "" : "s"} and ${fingerprintCount} fingerprint${fingerprintCount === 1 ? "" : "s"} blacklisted`,
      );
      setOpen(false);
      setReasonOption(null);
      setCustomReason("");
      // No `router.refresh()` and no route re-render — the action flushes
      // narrow tags only; `onSuccess` flips the optimistic Ban→Unban state
      // in UserAdminActions instantly, server truth re-syncs via the tags.
      onSuccess();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReasonOption(null);
          setCustomReason("");
        }
      }}
    >
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
          <Select value={reasonOption ?? undefined} onValueChange={setReasonOption}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a reason" />
            </SelectTrigger>
            <SelectContent>
              {BAN_REASON_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isCustom && (
            <Textarea
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder="Why is this user being banned?"
              rows={3}
              autoFocus
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isPending || !reasonOption || !effectiveReason}
            onClick={submit}
          >
            {isPending ? "Banning..." : "Confirm ban"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlockIdentifierButton({
  userId,
  kind,
}: {
  userId: string;
  kind: "ip" | "fingerprint";
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isIp = kind === "ip";
  const Icon = isIp ? Network : Fingerprint;
  const label = isIp ? "Ban IP" : "Ban fingerprint";

  function submit() {
    startTransition(async () => {
      const result = await blockUserIdentifiers({
        userId,
        kind,
        confirmed: true,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const count = isIp
        ? result.data.ipCount
        : result.data.fingerprintCount;
      toast.success(
        `${count} known ${isIp ? `IP address${count === 1 ? "" : "es"}` : `fingerprint${count === 1 ? "" : "s"}`} blacklisted`,
      );
      setOpen(false);
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
        onClick={() => setOpen(true)}
      >
        <Icon className="size-3.5" /> {label}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently blacklists every known{" "}
            {isIp ? "IP address" : "Fingerprint visitor ID"} tied to this
            user. Matching accounts will enter the existing Antifraud review
            and containment flow. This does not ban the user account itself.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={isPending}>
            {isPending ? "Blacklisting..." : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
