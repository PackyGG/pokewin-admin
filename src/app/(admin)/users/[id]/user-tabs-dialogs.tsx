"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDownToLine, Pencil, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
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
  AlertDialog,
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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { ROLES } from "@/lib/constants";
import {
  adjustBalance,
  adjustXp,
  changeRole,
  forceResetCreatorToUser,
  recordManualWithdrawal,
  wipeUserAccount,
  updateUserIdentity,
} from "./actions";
import { deleteUser } from "../actions";
import type { UserDetail } from "./user-tabs-types";

export function DeleteUserDialog({
  user,
  isPending: parentPending,
}: {
  user: UserDetail["user"];
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const username = user.username ?? user.email ?? user.id.slice(0, 8);
  const isConfirmed = confirm === username;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setConfirm("");
          setTotpCode("");
        }
      }}
    >
      <DialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={parentPending} />
        }
      >
        Delete
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-red-400">
            Delete User Permanently
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will{" "}
            <span className="font-semibold text-red-400">
              permanently delete
            </span>{" "}
            <span className="font-semibold text-foreground">{username}</span>{" "}
            and all their data (balances, inventory, transactions, sessions).
            This cannot be undone.
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Type{" "}
              <span className="font-mono font-semibold text-foreground">
                {username}
              </span>{" "}
              to confirm
            </Label>
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={username}
              autoComplete="off"
            />
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            disabled={!isConfirmed || !totpCode.trim() || isPending}
            onClick={() => {
              startTransition(async () => {
                try {
                  await deleteUser(user.id, totpCode.trim());
                  toast.success("User deleted");
                  router.push("/users");
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Failed to delete user",
                  );
                }
              });
            }}
          >
            {isPending ? "Deleting..." : "Delete User Permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Balance-adjust reason presets. Each option has a value stored in the
// ledger description and a label shown in the dropdown. "other" is the
// only option that surfaces a free-text field below the select.
const BALANCE_ADJUST_REASONS = [
  { value: "deposit_problem", label: "Deposit problem" },
  { value: "giveaway", label: "Giveaway" },
  { value: "bonus", label: "Bonus" },
  { value: "lossback", label: "Lossback" },
  { value: "streamer", label: "Streamer" },
  { value: "other", label: "Other" },
] as const;

export function BalanceAdjustDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reasonCategory, setReasonCategory] = useState<string>("");
  const [customReason, setCustomReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Resolve the final reason string sent to the server:
  //   - "Other" → user-typed custom text
  //   - any other preset → the preset's label (e.g. "Giveaway")
  function resolveReason(): string {
    if (!reasonCategory) return "";
    if (reasonCategory === "other") return customReason.trim();
    const preset = BALANCE_ADJUST_REASONS.find(
      (r) => r.value === reasonCategory,
    );
    return preset?.label ?? reasonCategory;
  }

  function handleAdjust() {
    const numAmount = parseFloat(amount);
    const resolvedReason = resolveReason();
    if (isNaN(numAmount)) {
      toast.error("Please enter a valid amount");
      return;
    }
    if (!resolvedReason) {
      toast.error(
        reasonCategory === "other"
          ? "Please enter a custom reason"
          : "Please pick a reason",
      );
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const result = await adjustBalance({
          userId,
          amount: numAmount,
          reason: resolvedReason,
          totpCode: totpCode.trim(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Balance adjusted");
        setAmount("");
        setReasonCategory("");
        setCustomReason("");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to adjust balance",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Balance</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount</Label>
            <Input
              type="number"
              placeholder="Amount (+/-)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reason</Label>
            <Select
              value={reasonCategory}
              onValueChange={(v) => {
                if (!v) return;
                setReasonCategory(v);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a reason..." />
              </SelectTrigger>
              <SelectContent>
                {BALANCE_ADJUST_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reasonCategory === "other" && (
              <Textarea
                placeholder="Enter custom reason..."
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                rows={2}
                className="mt-2"
              />
            )}
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleAdjust}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Manual Withdrawal Dialog ──────────────────────────────────────
//
// Records an off-platform payout (admin paid the user via bank/crypto/etc.
// outside the standard withdrawal flow). Deducts on-site balance + bumps
// `total_withdrawn` so PnL stays correct.

const MANUAL_WITHDRAWAL_REASONS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "crypto_send", label: "Crypto send" },
  { value: "paypal", label: "PayPal" },
  { value: "gift_card", label: "Gift card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
] as const;

export function ManualWithdrawalDialog({
  userId,
  availableBalance,
  open,
  onOpenChange,
}: {
  userId: string;
  availableBalance: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reasonCategory, setReasonCategory] = useState<string>("");
  const [customReason, setCustomReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function resolveReason(): string {
    if (!reasonCategory) return "";
    if (reasonCategory === "other") return customReason.trim();
    const preset = MANUAL_WITHDRAWAL_REASONS.find(
      (r) => r.value === reasonCategory,
    );
    return preset?.label ?? reasonCategory;
  }

  function handleSubmit() {
    const numAmount = parseFloat(amount);
    const resolvedReason = resolveReason();
    if (isNaN(numAmount) || numAmount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    // Note: we deliberately allow numAmount > availableBalance — the
    // server will deduct what exists and bump total_withdrawn by the
    // full amount (backfill mode for fixing P&L on past off-platform
    // payouts).
    if (!resolvedReason) {
      toast.error(
        reasonCategory === "other"
          ? "Please enter a custom reason"
          : "Please pick a reason",
      );
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        const result = await recordManualWithdrawal({
          userId,
          amountUsd: numAmount,
          reason: resolvedReason,
          totpCode: totpCode.trim(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success(`Recorded $${numAmount.toFixed(2)} manual withdrawal`);
        setAmount("");
        setReasonCategory("");
        setCustomReason("");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to record manual withdrawal",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDownToLine className="size-4 text-rose-500" />
            Record Manual Withdrawal
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Use this when you paid the user out off-platform (bank, crypto,
            etc.). Bumps <span className="font-mono">total_withdrawn</span>{" "}
            so P&amp;L stays correct. If they have on-site balance, it&apos;s
            deducted from there too. Works for backfilling historical
            payouts even when the user has $0 on-site.
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Amount (USD)
            </Label>
            <Input
              type="number"
              min={0}
              step={0.01}
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {(() => {
              const numAmount = parseFloat(amount);
              const exceeds =
                !isNaN(numAmount) && numAmount > availableBalance;
              if (exceeds) {
                const phantom = numAmount - availableBalance;
                return (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    On-site balance is ${availableBalance.toFixed(2)}. $
                    {availableBalance.toFixed(2)} will be deducted from
                    balance; the remaining ${phantom.toFixed(2)} only
                    bumps total_withdrawn (backfill / P&amp;L fix).
                  </p>
                );
              }
              return (
                <p className="text-[11px] text-muted-foreground">
                  Available: ${availableBalance.toFixed(2)}
                </p>
              );
            })()}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Payout method
            </Label>
            <Select
              value={reasonCategory}
              onValueChange={(v) => {
                if (!v) return;
                setReasonCategory(v);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="How did you pay them out?" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_WITHDRAWAL_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reasonCategory === "other" && (
              <Textarea
                placeholder="Describe the payout method"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
                rows={2}
                className="mt-2"
              />
            )}
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto bg-rose-500 hover:bg-rose-500/90 text-white"
          >
            {isPending ? "Recording..." : "Record Withdrawal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function XpAdjustDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleAdjust() {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || !reason.trim()) {
      toast.error("Please enter a valid amount and reason");
      return;
    }
    startTransition(async () => {
      try {
        await adjustXp({ userId, amount: numAmount, reason });
        toast.success("XP adjusted");
        setAmount("");
        setReason("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to adjust XP");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust XP</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount</Label>
            <Input
              type="number"
              placeholder="Amount (+/-)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reason</Label>
            <Textarea
              placeholder="Reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleAdjust}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Wipe Account Button + Confirmation Dialog (Admin Only)
// ---------------------------------------------------------------------------
// Two-gate destructive action: admin must (1) type-to-confirm the username
// AND (2) enter their current TOTP code. The server re-verifies both before
// running the wipe transaction.
export function WipeAccountButton({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isConfirmed = confirmValue === displayName;
  const hasTotp = totpCode.trim().length > 0;
  const canSubmit = isConfirmed && hasTotp && !isPending;

  function handleWipe() {
    if (!canSubmit) return;
    startTransition(async () => {
      try {
        const result = await wipeUserAccount(userId, totpCode.trim());
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Account data wiped successfully");
        setOpen(false);
        setConfirmValue("");
        setTotpCode("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to wipe account data",
        );
      }
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setConfirmValue("");
          setTotpCode("");
        }
      }}
    >
      <AlertDialogTrigger
        render={<Button variant="destructive" size="sm" />}
      >
        Wipe
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-rose-500" />
            Wipe All Account Data?
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This will <strong>permanently delete</strong> all data for this
              account: balances, transactions, inventory, battles, rewards,
              affiliate data, chat messages, and all ledger history.
            </span>
            <span className="block">
              The user record and login credentials will be preserved, but
              everything else will be gone.{" "}
              <strong>This cannot be undone.</strong>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Type{" "}
              <span className="font-mono font-semibold text-foreground">
                {displayName}
              </span>{" "}
              to confirm
            </Label>
            <Input
              value={confirmValue}
              onChange={(e) => setConfirmValue(e.target.value)}
              placeholder={displayName}
              className="font-mono"
              autoComplete="off"
            />
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
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleWipe}
            disabled={!canSubmit}
            className="w-full sm:w-auto"
          >
            <Trash2 className="mr-1.5 size-3.5" />
            {isPending ? "Wiping..." : "Wipe Account Data"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Change Role Dialog (Admin Only) — Select new role + confirm with 2FA
// ---------------------------------------------------------------------------
export function ChangeRoleDialog({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: string;
}) {
  const [open, setOpen] = useState(false);
  const [newRole, setNewRole] = useState<string>(currentRole);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) {
      // Reset form on close
      setNewRole(currentRole);
      setTotpCode("");
    }
  }

  function handleSubmit() {
    if (!newRole || newRole === currentRole) {
      toast.error("Please pick a different role");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        await changeRole(userId, newRole, totpCode.trim());
        toast.success("Role updated");
        setOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update role");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" className="h-8 gap-1.5" />}
      >
        <ShieldCheck className="size-3.5" />
        Change Role
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Role</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Role</Label>
            <Select
              value={newRole}
              onValueChange={(v) => {
                if (!v) return;
                setNewRole(v);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a role..." />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Current role:{" "}
              <span className="font-medium text-foreground">{currentRole}</span>
            </p>
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={
              isPending || !totpCode.trim() || newRole === currentRole
            }
            className="w-full sm:w-auto"
          >
            {isPending ? "Updating..." : "Change role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reset Role to User — escape hatch when the /creators backend demote
// gets stuck (returns success but doesn't actually flip role back).
// Calls `forceResetCreatorToUser` which:
//   1) tries `creatorsApi.demote()` first so the backend can roll back
//      promote-time side effects (creator-deal balance fills, cached
//      aggregations, session state) — this is the part that was
//      missing before; without it, the user's pre-creator P&L numbers
//      never come back to the dashboard
//   2) always writes `user.role = 'user'` directly so the role flip
//      is guaranteed even if the backend silently no-ops
// Only renders when the user's current role is "creator".
// ---------------------------------------------------------------------------
export function ResetRoleToUserButton({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: string;
}) {
  const [open, setOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  if (currentRole !== "creator") return null;

  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) setTotpCode("");
  }

  function handleSubmit() {
    if (!totpCode.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        // Combined action: backend demote (best-effort) + local role
        // flip (always). Tells us in the toast whether the backend
        // cleanup ran or was skipped — if skipped, the dashboard P&L
        // may still be off because backend-managed side effects (e.g.
        // creator balance fills) were never reverted.
        const result = await forceResetCreatorToUser(
          userId,
          totpCode.trim(),
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        if (result.backendDemoted) {
          toast.success(
            "Role reset to user — backend cleaned up + role flipped",
          );
        } else {
          toast.warning(
            `Role flipped locally, but backend demote failed${
              result.backendError ? `: ${result.backendError}` : ""
            }. P&L side effects may still need manual fix.`,
            { duration: 8000 },
          );
        }
        setOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to reset role",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            title="Force role back to 'user' (calls backend demote + direct DB write)"
          />
        }
      >
        <ShieldAlert className="size-3.5" />
        Reset to User
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset Role to User</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            Force-demotes this user from{" "}
            <span className="font-mono font-medium text-foreground">
              creator
            </span>{" "}
            back to{" "}
            <span className="font-mono font-medium text-foreground">user</span>.
          </p>
          <p className="text-xs text-muted-foreground">
            Runs <strong>backend demote</strong> first so promote-time
            side effects (creator-deal balance fills, cached
            aggregations, session state) are rolled back, then writes
            the role flip directly so it&apos;s guaranteed even if the
            backend silently no-ops. Use when the &quot;Revoke creator
            role&quot; button on /creators is unresponsive or the
            user&apos;s pre-creator numbers haven&apos;t come back to
            P&amp;L.
          </p>
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
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isPending || !totpCode.trim()}
            className="w-full sm:w-auto bg-amber-500 text-white hover:bg-amber-500/90"
          >
            {isPending ? "Resetting..." : "Reset Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit Identity Dialog (Admin Only) — Email / Username / Display Name
// ---------------------------------------------------------------------------
export function EditIdentityButton({ user }: { user: UserDetail["user"] }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(user.email ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [displayUsername, setDisplayUsername] = useState(
    user.displayUsername ?? "",
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Reset form values when dialog opens (in case user data changed)
  function handleOpenChange(v: boolean) {
    if (v) {
      setEmail(user.email ?? "");
      setUsername(user.username ?? "");
      setDisplayUsername(user.displayUsername ?? "");
    }
    setOpen(v);
  }

  function handleSave() {
    const changes: {
      email?: string;
      username?: string;
      displayUsername?: string;
    } = {};

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedUsername = username.trim();
    const trimmedDisplay = displayUsername.trim();

    if (trimmedEmail !== (user.email ?? "").toLowerCase()) {
      changes.email = trimmedEmail;
    }
    if (trimmedUsername !== (user.username ?? "")) {
      changes.username = trimmedUsername;
    }
    if (trimmedDisplay !== (user.displayUsername ?? "")) {
      changes.displayUsername = trimmedDisplay;
    }

    if (Object.keys(changes).length === 0) {
      toast.error("No changes to save");
      return;
    }

    startTransition(async () => {
      try {
        const result = await updateUserIdentity(user.id, changes);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("User identity updated");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to update identity",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon" className="size-6" />
        }
      >
        <Pencil className="size-3" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit User Identity</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              type="email"
            />
            <p className="text-xs text-muted-foreground">
              Will be automatically verified on save.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Username</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
            />
            <p className="text-xs text-muted-foreground">
              Must be unique. 3–20 characters.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Display Name</Label>
            <Input
              value={displayUsername}
              onChange={(e) => setDisplayUsername(e.target.value)}
              placeholder="Display name (optional)"
            />
            <p className="text-xs text-muted-foreground">
              Shown instead of username. Leave empty to use username.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={handleSave}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            {isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
