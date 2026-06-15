"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  ArrowRight,
  Copy,
  Pencil,
  UserPlus,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ux";
import type { RoleSummary } from "./roles-overview-data";
import { deleteRole, duplicateRole } from "./custom-roles-actions";
import { renameRole } from "./role-rename-action";

/**
 * The kebab (⋯) action menu on a unified role card, plus the dialogs the menu
 * items open. ONE concept: Role. Every role gets Open + Duplicate; the 5
 * non-`admin` system rows and custom roles can be renamed; only custom roles
 * can be deleted; `admin` (the one superuser role) has Rename + Delete disabled
 * with a tooltip.
 *
 * Mutations:
 *   • Duplicate → `duplicateRole(sourceId, newName, code)` (copies capabilities
 *     + limits into a NEW custom role, 2FA-gated) → navigates to its editor.
 *   • Rename   → `renameRole(id, newName, code)` (writes the DISPLAY name only;
 *     identity stays `system_key`/enum for system rows), 2FA-gated.
 *   • Delete   → `deleteRole(id, code)` (custom only, 2FA-gated).
 *   • Assign   → navigates to the role editor, whose "Assigned admins" panel +
 *     guidance is the assignment surface (the per-user "Role preset" select on
 *     /admin-users/[id] is the primary path).
 *
 * No function props cross the RSC boundary — the parent passes a plain
 * serializable {@link RoleSummary}.
 */
export function RoleCardActions({ role }: { role: RoleSummary }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // `admin` is the one superuser role: its name is locked and it can't be
  // deleted. Other system rows: renameable, not deletable. Custom: both.
  const canRename = !role.isSuperuser;
  const canDelete = !role.isSystem;
  const hasEditor = role.id !== null;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${role.name}`}
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {hasEditor && (
            <DropdownMenuItem
              onClick={() => router.push(`/admin-users/roles/${role.id}`)}
            >
              <ArrowRight className="size-4" />
              Open
            </DropdownMenuItem>
          )}
          {hasEditor && (
            <DropdownMenuItem onClick={() => setDuplicateOpen(true)}>
              <Copy className="size-4" />
              Duplicate
            </DropdownMenuItem>
          )}
          <RenameItem
            disabled={!canRename || !hasEditor}
            onSelect={() => setRenameOpen(true)}
          />
          {hasEditor && (
            <DropdownMenuItem
              onClick={() => router.push(`/admin-users/roles/${role.id}`)}
            >
              <UserPlus className="size-4" />
              Assign to admin…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DeleteItem
            disabled={!canDelete}
            superuser={role.isSuperuser}
            onSelect={() => setDeleteOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {hasEditor && (
        <DuplicateDialog
          role={role}
          open={duplicateOpen}
          onOpenChange={setDuplicateOpen}
        />
      )}
      {hasEditor && canRename && (
        <RenameDialog role={role} open={renameOpen} onOpenChange={setRenameOpen} />
      )}
      {canDelete && (
        <DeleteDialog
          role={role}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDeleted={() => router.refresh()}
        />
      )}
    </>
  );
}

/** Rename item — disabled with a tooltip on `admin`/system-locked rows. */
function RenameItem({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: () => void;
}) {
  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuItem
              disabled
              // base-ui keeps the menu from closing on a disabled item; the
              // tooltip explains why.
              onClick={(e) => e.preventDefault()}
            />
          }
        >
          <Pencil className="size-4" />
          Rename
        </TooltipTrigger>
        <TooltipContent side="left">
          The admin role&apos;s name is locked.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenuItem onClick={onSelect}>
      <Pencil className="size-4" />
      Rename
    </DropdownMenuItem>
  );
}

/** Delete item — disabled with a tooltip on system rows (protected backbone). */
function DeleteItem({
  disabled,
  superuser,
  onSelect,
}: {
  disabled: boolean;
  superuser: boolean;
  onSelect: () => void;
}) {
  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuItem
              disabled
              variant="destructive"
              onClick={(e) => e.preventDefault()}
            />
          }
        >
          <Trash2 className="size-4" />
          Delete
        </TooltipTrigger>
        <TooltipContent side="left">
          {superuser
            ? "The admin role can't be deleted."
            : "Built-in roles can't be deleted."}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenuItem variant="destructive" onClick={onSelect}>
      <Trash2 className="size-4" />
      Delete
    </DropdownMenuItem>
  );
}

/**
 * Duplicate dialog: pre-fills a "<name> copy" name + a 2FA code, creates a NEW
 * custom role with the source's capabilities, copies its limits, then opens the
 * new role's editor (pre-filled, because the editor reads from the DB).
 */
function DuplicateDialog({
  role,
  open,
  onOpenChange,
}: {
  role: RoleSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(`${role.name} copy`);
  const [code, setCode] = useState("");
  const [isPending, startTransition] = useTransition();

  function reset() {
    setName(`${role.name} copy`);
    setCode("");
  }

  function handleDuplicate() {
    if (!role.id) return;
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!code.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const res = await duplicateRole(role.id!, name.trim(), code.trim());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role duplicated");
      onOpenChange(false);
      reset();
      router.push(`/admin-users/roles/${res.id}`);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="size-4 text-emerald-500" />
            Duplicate &quot;{role.name}&quot;
          </DialogTitle>
          <DialogDescription>
            Creates a new custom role with the same capabilities and limits.
            You&apos;ll be taken to its editor to adjust it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="dup-name">New role name</Label>
            <Input
              id="dup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dup-code" className="text-xs text-muted-foreground">
              2FA Code
            </Label>
            <Input
              id="dup-code"
              type="text"
              inputMode="numeric"
              placeholder="Enter your 6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleDuplicate}
            disabled={isPending || !name.trim() || !code.trim()}
            className="w-full sm:w-auto"
          >
            {isPending && <Spinner size={14} className="text-current" />}
            {isPending ? "Duplicating..." : "Duplicate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rename dialog: writes the DISPLAY name only. For a system row the identity
 * stays `system_key`/enum (renameRole routes a system row through
 * `updateBuiltInRole`, which keeps system_key as identity); a custom row writes
 * `admin_roles.name`. 2FA-gated.
 */
function RenameDialog({
  role,
  open,
  onOpenChange,
}: {
  role: RoleSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(role.name);
  const [code, setCode] = useState("");
  const [isPending, startTransition] = useTransition();

  function reset() {
    setName(role.name);
    setCode("");
  }

  function handleRename() {
    if (!role.id) return;
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!code.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const res = await renameRole(role.id!, name.trim(), code.trim());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role renamed");
      onOpenChange(false);
      setCode("");
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4 text-blue-500" />
            Rename &quot;{role.name}&quot;
          </DialogTitle>
          <DialogDescription>
            {role.isSystem
              ? "Changes the display name only — this stays a built-in role with the same identity and access."
              : "Changes this role's display name."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-name">Name</Label>
            <Input
              id="rename-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rename-code" className="text-xs text-muted-foreground">
              2FA Code
            </Label>
            <Input
              id="rename-code"
              type="text"
              inputMode="numeric"
              placeholder="Enter your 6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleRename}
            disabled={isPending || !name.trim() || !code.trim()}
            className="w-full sm:w-auto"
          >
            {isPending && <Spinner size={14} className="text-current" />}
            {isPending ? "Saving..." : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Delete confirm (custom roles only) with a 2FA code. */
function DeleteDialog({
  role,
  open,
  onOpenChange,
  onDeleted,
}: {
  role: RoleSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDeleted: () => void;
}) {
  const [code, setCode] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    if (!role.id) return;
    if (!code.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const res = await deleteRole(role.id!, code.trim());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role deleted");
      onOpenChange(false);
      setCode("");
      onDeleted();
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setCode("");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete role &quot;{role.name}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            {role.holderCount > 0
              ? `${role.holderCount} user(s) will lose this role link. They keep their current effective permissions — you can assign a different role any time.`
              : "This cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="del-code" className="text-xs text-muted-foreground">
            2FA Code
          </Label>
          <Input
            id="del-code"
            type="text"
            inputMode="numeric"
            placeholder="Enter your 6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
            autoComplete="one-time-code"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Keep the dialog open until the action resolves (so errors show).
              e.preventDefault();
              handleDelete();
            }}
            disabled={isPending || !code.trim()}
          >
            {isPending && <Spinner size={14} className="text-current" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
