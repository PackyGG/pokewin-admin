"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StepUpField } from "@/components/step-up-field";
import { ROLES } from "@/lib/constants";
import { changeRole } from "@/app/(admin)/users/[id]/actions";

export function RoleSelect({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  function handleChange(newRole: string | null) {
    if (!newRole || newRole === currentRole) return;
    setPendingRole(newRole);
    setTotpCode("");
    setDialogOpen(true);
  }

  function handleConfirm() {
    if (!pendingRole || !totpCode.trim()) return;
    startTransition(async () => {
      try {
        // Single-role picker: submits the picked role as the user's whole
        // role set (matches its pre-multi-role semantics — replace, not
        // add). `changeRole` now takes an array (multi-select support in
        // the /users/[id] `ChangeRoleDialog`); this dropdown stays single-
        // select on purpose, so it just wraps the one value.
        await changeRole(userId, [pendingRole], totpCode.trim());
        toast.success("Role updated");
        setDialogOpen(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update role");
      }
    });
  }

  return (
    <>
      <Select value={currentRole} onValueChange={handleChange} disabled={isPending}>
        <SelectTrigger
          size="sm"
          className="!h-6 !px-1.5 !py-0 !gap-1 !w-fit !rounded-md border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:!size-3 dark:bg-transparent dark:hover:bg-accent"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((r) => (
            <SelectItem key={r} value={r}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Role Change</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Change role to <span className="font-medium text-foreground">{pendingRole}</span>. Enter your 2FA code to confirm.
            </p>
            <StepUpField value={totpCode} onChange={setTotpCode} />
          </div>
          <DialogFooter>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              disabled={isPending || !totpCode.trim()}
              onClick={handleConfirm}
            >
              {isPending ? "Updating..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
