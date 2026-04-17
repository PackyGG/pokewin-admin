"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, ShieldCheck } from "lucide-react";
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
          <Button
            variant="destructive"
            className="w-full"
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
        </div>
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
            className="w-full"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
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
            className="w-full"
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
export function WipeAccountButton({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isConfirmed = confirmValue === displayName;

  function handleWipe() {
    if (!isConfirmed) return;
    startTransition(async () => {
      try {
        const result = await wipeUserAccount(userId, confirmValue);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Account data wiped successfully");
        setOpen(false);
        setConfirmValue("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to wipe account data",
        );
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setConfirmValue(""); }}>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" />
        }
      >
        Wipe
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Wipe All Account Data?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This will <strong>permanently delete</strong> all data for this
              account: balances, transactions, inventory, battles, rewards,
              affiliate data, chat messages, and all ledger history.
            </span>
            <span className="block">
              The user record and login credentials will be preserved, but
              everything else will be gone. <strong>This cannot be undone.</strong>
            </span>
            <span className="mt-3 block text-sm">
              Type <strong className="font-mono text-foreground">{displayName}</strong> to confirm:
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmValue}
          onChange={(e) => setConfirmValue(e.target.value)}
          placeholder={displayName}
          className="font-mono"
          autoComplete="off"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleWipe}
            disabled={!isConfirmed || isPending}
          >
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
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={
              isPending || !totpCode.trim() || newRole === currentRole
            }
          >
            {isPending ? "Updating..." : "Change role"}
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
          <Button
            onClick={handleSave}
            disabled={isPending}
            className="w-full"
          >
            {isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
