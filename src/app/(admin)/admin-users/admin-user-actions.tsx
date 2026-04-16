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
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, setIsPending] = useState(false);

  const newRole = role === "admin" ? "support" : "admin";

  async function handleToggleActive() {
    try {
      await toggleAdminActive(userId, !isActive);
      toast.success(isActive ? "Admin deactivated" : "Admin activated");
    } catch {
      toast.error("Failed to update status");
    }
  }

  async function handleReset2FA() {
    if (!confirm("Reset 2FA for this admin? They will need to set it up again on next login.")) return;
    try {
      await resetAdmin2FA(userId);
      toast.success("2FA reset");
    } catch {
      toast.error("Failed to reset 2FA");
    }
  }

  async function handleDelete() {
    if (!confirm("Permanently delete this admin user? Their audit logs will be preserved but they will lose all access.")) return;
    try {
      const result = await deleteAdminUser(userId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Admin user deleted");
    } catch {
      toast.error("Failed to delete admin user");
    }
  }

  async function handleConfirmRoleChange() {
    if (!totpCode.trim()) return;
    setIsPending(true);
    try {
      await changeAdminRole(userId, newRole, totpCode.trim());
      toast.success(`Role changed to ${newRole}`);
      setRoleDialogOpen(false);
      setTotpCode("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to change role");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-8" />}>
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleToggleActive}>
            {isActive ? "Deactivate" : "Activate"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { setTotpCode(""); setRoleDialogOpen(true); }}>
            Change to {role === "admin" ? "Support" : "Admin"}
          </DropdownMenuItem>
          {totpEnabled && (
            <DropdownMenuItem onClick={handleReset2FA} className="text-destructive">
              Reset 2FA
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={handleDelete} className="text-destructive">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Role Change</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Change role to <span className="font-medium text-foreground">{newRole}</span>. Enter your 2FA code to confirm.
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
              className="w-full"
              disabled={isPending || !totpCode.trim()}
              onClick={handleConfirmRoleChange}
            >
              {isPending ? "Updating..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
