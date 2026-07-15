"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MoreHorizontal, ShieldCheck, UserCog, Power, Trash2 } from "lucide-react";
import { StepUpField } from "@/components/step-up-field";
import type { AdminRole } from "@/lib/dal";
import { Spinner } from "@/components/ux";
import { RolesEditor } from "./_components/roles-editor";
import {
  toggleAdminActive,
  resetAdmin2FA,
  setAdminRoles,
  deleteAdminUser,
} from "./actions";
import { toast } from "sonner";

// Mode discriminator for the active dialog. Each privileged action shares
// the same TOTP-gated confirm dialog so the UX matches /users/[id].
//   - editRoles : multi-role checkbox group → setAdminRoles
//   - toggle    : activate / deactivate
//   - reset2fa  : wipe TOTP secret
//   - delete    : permanent delete
type DialogMode = "editRoles" | "toggle" | "reset2fa" | "delete";

/**
 * Row-level action menu for an admin user. Supports the FULL multi-role
 * assignment (any combination of the 5 system roles) via setAdminRoles —
 * the same additive, 2FA-gated, audited action the detail page uses —
 * plus activate/deactivate, reset 2FA, a link to the full detail page
 * (where page-access / permissions can be edited), and delete.
 *
 * Every mutating action is gated server-side (requireAdmin +
 * requireCapability + require2FA) and writes an admin_audit_event; the
 * dialog merely collects the operator's TOTP code. Clicks inside the menu
 * / dialog stopPropagation so they never trigger the row's navigate-to-
 * detail handler.
 */
export function AdminUserActions({
  userId,
  username,
  isActive,
  totpEnabled,
  roles,
  isSelf,
  rolesColumnExists,
}: {
  userId: string;
  username: string;
  isActive: boolean;
  totpEnabled: boolean;
  roles: AdminRole[];
  /** True when this row is the signed-in admin — blocks self-deactivate/delete. */
  isSelf: boolean;
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<DialogMode | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, setIsPending] = useState(false);
  // Working copy of the role set for the editRoles dialog. Seeded from the
  // user's current effective roles each time the dialog opens.
  const [selectedRoles, setSelectedRoles] = useState<Set<AdminRole>>(
    () => new Set(roles),
  );

  function openDialog(next: DialogMode) {
    setMode(next);
    setTotpCode("");
    if (next === "editRoles") setSelectedRoles(new Set(roles));
  }

  function closeDialog() {
    setMode(null);
    setTotpCode("");
    setIsPending(false);
  }

  const currentRoleKey = [...roles].sort().join(",");
  const pickedRoleKey = [...selectedRoles].sort().join(",");
  const rolesDirty = currentRoleKey !== pickedRoleKey;
  const rolesEmpty = selectedRoles.size === 0;

  async function handleConfirm() {
    if (!mode) return;
    const code = totpCode.trim();
    if (!code) return;
    setIsPending(true);
    try {
      if (mode === "editRoles") {
        if (!rolesDirty || rolesEmpty) {
          setIsPending(false);
          return;
        }
        await setAdminRoles(userId, [...selectedRoles], code);
        toast.success("Roles updated");
      } else if (mode === "toggle") {
        await toggleAdminActive(userId, !isActive, code);
        toast.success(isActive ? "Admin deactivated" : "Admin activated");
      } else if (mode === "reset2fa") {
        await resetAdmin2FA(userId, code);
        toast.success("2FA reset");
      } else if (mode === "delete") {
        const result = await deleteAdminUser(userId, code);
        if (!result.success) {
          toast.error(result.error);
          setIsPending(false);
          return;
        }
        toast.success("Admin user deleted");
      }
      closeDialog();
      // The server actions revalidatePath("/admin-users"), but this client
      // component won't re-render with the fresh server data until the route
      // is refreshed — mirror the detail page's ManagementActions so the row's
      // status/roles flip (or the deleted row vanishes) without a manual reload.
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
      setIsPending(false);
    }
  }

  const headerConfig: Record<DialogMode, { title: string; description: string; confirmLabel: string }> = {
    editRoles: {
      title: `Edit roles for ${username}`,
      description:
        "A user can hold several roles at once and gets the combined access of all of them. Adding a role only ever grants access; manual per-user grants are kept.",
      confirmLabel: "Save roles",
    },
    toggle: {
      title: isActive ? `Deactivate ${username}` : `Activate ${username}`,
      description: isActive
        ? "This will prevent the admin from logging in. Enter your 2FA code to confirm."
        : "This will allow the admin to log in again. Enter your 2FA code to confirm.",
      confirmLabel: isActive ? "Deactivate" : "Activate",
    },
    reset2fa: {
      title: `Reset 2FA for ${username}`,
      description:
        "Wipes the admin's TOTP secret. They will need to set up 2FA again on next login. Enter your 2FA code to confirm.",
      confirmLabel: "Reset 2FA",
    },
    delete: {
      title: `Delete ${username}`,
      description:
        "Permanently deletes this admin user. Their audit logs are preserved but they lose all access. Enter your 2FA code to confirm.",
      confirmLabel: "Delete",
    },
  };

  const confirmDisabled =
    isPending ||
    !totpCode.trim() ||
    (mode === "editRoles" && (!rolesDirty || rolesEmpty));

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" className="size-8" />}
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Open actions for {username}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* `render={<Link/>}` composes the menu item onto a Link; the
              icon + label are children base-ui merges into it. Matches the
              creator-row-actions pattern. The detail page is where the
              per-user page-access / permissions editor lives, so this is
              also the entry point for editing page access. */}
          <DropdownMenuItem render={<Link href={`/admin-users/${userId}`} />}>
            <UserCog className="mr-2 size-4" />
            Manage (detail / page access)
          </DropdownMenuItem>
          {/* onClick (NOT onSelect) — base-ui's Menu.Item has no `onSelect`
              prop, so an `onSelect` handler is passed through as the DOM
              `onSelect` attribute, which only fires on text selection and
              NEVER on a menu-item press → the dialog never opened (the bug
              that made list-row Deactivate/Delete dead). `onClick` is the
              base-ui way and matches the working role-card-actions kebab on
              this same surface. base-ui still closes the menu on click
              (closeOnClick), then the controlled dialog opens. */}
          <DropdownMenuItem onClick={() => openDialog("editRoles")}>
            <ShieldCheck className="mr-2 size-4" />
            Edit roles
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              if (!(isSelf && isActive)) openDialog("toggle");
            }}
            disabled={isSelf && isActive}
          >
            <Power className="mr-2 size-4" />
            {isActive ? "Deactivate" : "Activate"}
          </DropdownMenuItem>
          {totpEnabled && (
            <DropdownMenuItem
              onClick={() => openDialog("reset2fa")}
              variant="destructive"
            >
              <ShieldCheck className="mr-2 size-4" />
              Reset 2FA
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => {
              if (!isSelf) openDialog("delete");
            }}
            variant="destructive"
            disabled={isSelf}
          >
            <Trash2 className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={mode !== null}
        onOpenChange={(v) => {
          if (!v) closeDialog();
        }}
      >
        <DialogContent
          className={mode === "editRoles" ? "sm:max-w-md" : "sm:max-w-sm"}
        >
          <DialogHeader>
            <DialogTitle>{mode ? headerConfig[mode].title : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {mode ? headerConfig[mode].description : ""}
            </p>

            {mode === "editRoles" && (
              <RolesEditor
                selected={selectedRoles}
                onChange={setSelectedRoles}
                rolesColumnExists={rolesColumnExists}
                disabled={isPending}
              />
            )}

            <StepUpField
              value={totpCode}
              onChange={setTotpCode}
              autoFocus={mode !== "editRoles"}
            />
          </div>
          <DialogFooter>
            <Button
              size="sm"
              variant={mode === "delete" || mode === "reset2fa" ? "destructive" : "default"}
              className="w-full sm:w-auto"
              disabled={confirmDisabled}
              onClick={handleConfirm}
            >
              {isPending && <Spinner size={14} className="text-current" />}
              {isPending
                ? "Working..."
                : mode
                  ? headerConfig[mode].confirmLabel
                  : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
