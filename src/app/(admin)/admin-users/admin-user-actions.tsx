"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoreHorizontal } from "lucide-react";
import { toggleAdminActive, resetAdmin2FA, changeAdminRole, deleteAdminUser } from "./actions";
import { toast } from "sonner";

// Mode discriminator for the shared TOTP confirmation dialog. Each
// privileged action (toggle, reset 2fa, delete, change role) reuses the
// same dialog so admins can copy/paste the 6-digit code into one place
// per action — keeps the UX consistent with /users/[id] dialogs.
type TotpAction = "toggle" | "reset2fa" | "delete" | "changeRole";

export function AdminUserActions({
  userId,
  isActive,
  totpEnabled,
  role,
}: {
  userId: string;
  isActive: boolean;
  totpEnabled: boolean;
  role: string;
}) {
  const [dialogAction, setDialogAction] = useState<TotpAction | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, setIsPending] = useState(false);

  const newRole = role === "admin" ? "support" : "admin";

  function openDialog(action: TotpAction) {
    setDialogAction(action);
    setTotpCode("");
  }

  function closeDialog() {
    setDialogAction(null);
    setTotpCode("");
    setIsPending(false);
  }

  async function handleConfirm() {
    if (!totpCode.trim() || !dialogAction) return;
    setIsPending(true);
    try {
      if (dialogAction === "toggle") {
        await toggleAdminActive(userId, !isActive, totpCode.trim());
        toast.success(isActive ? "Admin deactivated" : "Admin activated");
      } else if (dialogAction === "reset2fa") {
        await resetAdmin2FA(userId, totpCode.trim());
        toast.success("2FA reset");
      } else if (dialogAction === "delete") {
        const result = await deleteAdminUser(userId, totpCode.trim());
        if (!result.success) {
          toast.error(result.error);
          setIsPending(false);
          return;
        }
        toast.success("Admin user deleted");
      } else if (dialogAction === "changeRole") {
        await changeAdminRole(userId, newRole, totpCode.trim());
        toast.success(`Role changed to ${newRole}`);
      }
      closeDialog();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
      setIsPending(false);
    }
  }

  const dialogConfig: Record<TotpAction, { title: string; description: string; confirmLabel: string }> = {
    toggle: {
      title: isActive ? "Deactivate Admin" : "Activate Admin",
      description: isActive
        ? "This will prevent the admin from logging in. Enter your 2FA code to confirm."
        : "This will allow the admin to log in again. Enter your 2FA code to confirm.",
      confirmLabel: isActive ? "Deactivate" : "Activate",
    },
    reset2fa: {
      title: "Reset 2FA",
      description:
        "Wipes the admin's TOTP secret. They will need to set up 2FA again on next login. Enter your 2FA code to confirm.",
      confirmLabel: "Reset 2FA",
    },
    delete: {
      title: "Delete Admin User",
      description:
        "Permanently deletes this admin user. Their audit logs will be preserved but they lose all access. Enter your 2FA code to confirm.",
      confirmLabel: "Delete",
    },
    changeRole: {
      title: "Confirm Role Change",
      description: `Change role to ${newRole}. Enter your 2FA code to confirm.`,
      confirmLabel: "Confirm",
    },
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-8" />}>
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openDialog("toggle")}>
            {isActive ? "Deactivate" : "Activate"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDialog("changeRole")}>
            Change to {role === "admin" ? "Support" : "Admin"}
          </DropdownMenuItem>
          {totpEnabled && (
            <DropdownMenuItem onClick={() => openDialog("reset2fa")} className="text-destructive">
              Reset 2FA
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => openDialog("delete")} className="text-destructive">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialogAction !== null} onOpenChange={(v) => { if (!v) closeDialog(); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dialogAction ? dialogConfig[dialogAction].title : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {dialogAction ? dialogConfig[dialogAction].description : ""}
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
              size="sm"
              className="w-full sm:w-auto"
              disabled={isPending || !totpCode.trim()}
              onClick={handleConfirm}
            >
              {isPending ? "Updating..." : dialogAction ? dialogConfig[dialogAction].confirmLabel : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
