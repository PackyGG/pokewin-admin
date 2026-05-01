"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminRole } from "@/lib/dal";
import {
  toggleAdminActive,
  changeAdminRole,
  resetAdmin2FA,
} from "../actions";
import { forceExpireAllSessions } from "./actions";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Management Actions ── */
export function ManagementActions({
  detail,
  startTransition,
}: {
  detail: AdminUserDetail;
  startTransition: React.TransitionStartFunction;
}) {
  const router = useRouter();

  function handleAction(action: () => Promise<void>, label: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(label);
        router.refresh();
      } catch {
        toast.error(`Failed: ${label}`);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Management</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <AlertDialog>
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
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  handleAction(
                    () => toggleAdminActive(detail.id, !detail.isActive),
                    detail.isActive ? "Admin deactivated" : "Admin activated"
                  )
                }
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <ChangeRoleDialog detail={detail} handleAction={handleAction} />

        {detail.totpEnabled && (
          <AlertDialog>
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
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    handleAction(() => resetAdmin2FA(detail.id), "2FA reset")
                  }
                >
                  Confirm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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

const ALL_ADMIN_ROLES: AdminRole[] = [
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
];
const ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Admin",
  support: "Support",
  marketing: "Marketing",
  creator: "Creator",
  pack_creator: "Pack Creator",
};

export function ChangeRoleDialog({
  detail,
  handleAction,
}: {
  detail: AdminUserDetail;
  handleAction: (action: () => Promise<void>, label: string) => void;
}) {
  const [selectedRole, setSelectedRole] = useState<AdminRole | "">(
    ""
  );
  const [totpCode, setTotpCode] = useState("");
  const otherRoles = ALL_ADMIN_ROLES.filter((r) => r !== detail.role);

  return (
    <AlertDialog>
      <AlertDialogTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
        Change Role
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change role for {detail.username}?</AlertDialogTitle>
          <AlertDialogDescription>
            Current role: <span className="font-medium uppercase">{detail.role}</span>.
            Select a new role below.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as AdminRole)}>
          <SelectTrigger>
            <SelectValue placeholder="Select new role" />
          </SelectTrigger>
          <SelectContent>
            {otherRoles.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
          <AlertDialogCancel onClick={() => { setTotpCode(""); setSelectedRole(""); }}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!selectedRole || !totpCode.trim()}
            onClick={() => {
              if (selectedRole && totpCode.trim()) {
                handleAction(
                  () => changeAdminRole(detail.id, selectedRole, totpCode.trim()),
                  "Role changed"
                );
                setTotpCode("");
              }
            }}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
