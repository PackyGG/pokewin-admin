"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { AdminRole } from "@/lib/dal";
import { RolesEditor } from "../_components/roles-editor";
import {
  toggleAdminActive,
  setAdminRoles,
  resetAdmin2FA,
} from "../actions";
import { forceExpireAllSessions } from "./actions";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Management Actions ── */
export function ManagementActions({
  detail,
  startTransition,
  rolesColumnExists,
}: {
  detail: AdminUserDetail;
  startTransition: React.TransitionStartFunction;
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
}) {
  const router = useRouter();

  function handleAction(action: () => Promise<void>, label: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(label);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed: ${label}`);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Management</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <ToggleActiveDialog detail={detail} handleAction={handleAction} />

        <ChangeRoleDialog
          detail={detail}
          handleAction={handleAction}
          rolesColumnExists={rolesColumnExists}
        />

        {detail.totpEnabled && (
          <Reset2FADialog detail={detail} handleAction={handleAction} />
        )}

        <AlertDialog>
          <AlertDialogTrigger className={buttonVariants({ variant: "destructive", size: "sm" })}>
            Expire All Sessions
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Force expire all sessions?</AlertDialogTitle>
              <AlertDialogDescription>
                All active sessions for {detail.username} will be invalidated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  handleAction(
                    () => forceExpireAllSessions(detail.id),
                    "Sessions expired"
                  )
                }
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ── Toggle Active Dialog (with TOTP) ──────────────────────────────────
//
// Toggling another admin's active state is a privilege-escalation-class
// action, so it gates on TOTP. Self-deactivation is also blocked
// server-side; the error surfaces here as a toast.
function ToggleActiveDialog({
  detail,
  handleAction,
}: {
  detail: AdminUserDetail;
  handleAction: (action: () => Promise<void>, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setTotpCode("");
      }}
    >
      <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        {detail.isActive ? "Deactivate" : "Activate"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {detail.isActive ? "Deactivate" : "Activate"} {detail.username}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {detail.isActive
              ? "This will prevent the admin from logging in."
              : "This will allow the admin to log in again."}
          </AlertDialogDescription>
        </AlertDialogHeader>
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
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={!totpCode.trim()}
            onClick={() => {
              handleAction(
                () =>
                  toggleAdminActive(
                    detail.id,
                    !detail.isActive,
                    totpCode.trim(),
                  ),
                detail.isActive ? "Admin deactivated" : "Admin activated",
              );
              setTotpCode("");
              setOpen(false);
            }}
          >
            Confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Reset 2FA Dialog (with TOTP) ──────────────────────────────────────
//
// Resetting another admin's 2FA wipes their TOTP secret. Without a
// second-factor on the actor side, a phished password could permanently
// strip 2FA from any admin — so this gates on the actor's TOTP.
function Reset2FADialog({
  detail,
  handleAction,
}: {
  detail: AdminUserDetail;
  handleAction: (action: () => Promise<void>, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setTotpCode("");
      }}
    >
      <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        Reset 2FA
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset 2FA for {detail.username}?</AlertDialogTitle>
          <AlertDialogDescription>
            They will need to set up 2FA again on next login.
          </AlertDialogDescription>
        </AlertDialogHeader>
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
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={!totpCode.trim()}
            onClick={() => {
              handleAction(
                () => resetAdmin2FA(detail.id, totpCode.trim()),
                "2FA reset",
              );
              setTotpCode("");
              setOpen(false);
            }}
          >
            Confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Multi-role editor. An admin can grant several system roles to one user
 * at once (e.g. Support + Pack Creator). Preselected to the user's current
 * effective roles; the RolesEditor shows them as removable chips with an
 * add-picker for the rest. Saving replaces the set. Permissions are merged
 * additively server-side (setAdminRoles) so adding a role only grants
 * access. 2FA-gated, exactly like the old single-role change.
 */
export function ChangeRoleDialog({
  detail,
  handleAction,
  rolesColumnExists,
}: {
  detail: AdminUserDetail;
  handleAction: (action: () => Promise<void>, label: string) => void;
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<AdminRole>>(
    () => new Set(detail.roles as AdminRole[]),
  );
  const [totpCode, setTotpCode] = useState("");

  function reset() {
    setSelected(new Set(detail.roles as AdminRole[]));
    setTotpCode("");
  }

  const current = [...detail.roles].sort().join(",");
  const picked = [...selected].sort().join(",");
  const dirty = current !== picked;
  const empty = selected.size === 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        Edit Roles
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Edit roles for {detail.username}</AlertDialogTitle>
          <AlertDialogDescription>
            A user can hold several roles at once and gets the combined access
            of all of them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RolesEditor
          selected={selected}
          onChange={setSelected}
          rolesColumnExists={rolesColumnExists}
        />
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
        <AlertDialogFooter>
          <AlertDialogCancel onClick={reset}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!dirty || empty || !totpCode.trim()}
            onClick={() => {
              if (dirty && !empty && totpCode.trim()) {
                handleAction(
                  () => setAdminRoles(detail.id, [...selected], totpCode.trim()),
                  "Roles updated",
                );
                setTotpCode("");
                setOpen(false);
              }
            }}
          >
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
