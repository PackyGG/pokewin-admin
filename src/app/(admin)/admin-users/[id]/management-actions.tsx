"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
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
  toggleAdminActive,
  resetAdmin2FA,
} from "../actions";
import { forceExpireAllSessions, resetAdminPassword } from "./actions";
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

        {detail.totpEnabled && (
          <Reset2FADialog detail={detail} handleAction={handleAction} />
        )}

        <ResetPasswordDialog detail={detail} handleAction={handleAction} />

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

// ── Reset Password Dialog (with step-up) ──────────────────────────────
//
// Password resets are credential changes, so the acting admin must step up
// with their own TOTP or passkey. The server also revokes the target's sessions.
function ResetPasswordDialog({
  detail,
  handleAction,
}: {
  detail: AdminUserDetail;
  handleAction: (action: () => Promise<void>, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [stepUpCredential, setStepUpCredential] = useState("");

  function reset() {
    setNewPassword("");
    setConfirmPassword("");
    setStepUpCredential("");
  }

  const passwordBytes = new TextEncoder().encode(newPassword).byteLength;
  const passwordReady =
    newPassword.length >= 10 &&
    passwordBytes <= 72 &&
    newPassword === confirmPassword &&
    stepUpCredential.trim().length > 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) reset();
      }}
    >
      <AlertDialogTrigger
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Reset Password
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Reset password for {detail.username}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Set a new password and share it securely with the staff member.
            Their existing sessions will be signed out immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="admin-reset-password">New password</Label>
            <Input
              id="admin-reset-password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least 10 characters and at most 72 UTF-8 bytes.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-reset-password-confirm">
              Confirm password
            </Label>
            <Input
              id="admin-reset-password-confirm"
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </div>
        </div>

        <StepUpField
          value={stepUpCredential}
          onChange={setStepUpCredential}
        />

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={!passwordReady}
            onClick={() => {
              const payload = {
                newPassword,
                confirmPassword,
                stepUpCredential: stepUpCredential.trim(),
              };
              handleAction(
                () => resetAdminPassword(detail.id, payload),
                "Password reset",
              );
              reset();
              setOpen(false);
            }}
          >
            Reset password
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Toggle Active Dialog (with TOTP) ──────────────────────────────────
//
// Toggling another admin's active state is a privilege-escalation-class
// action, so it gates on TOTP. Self-deactivation is also blocked server-side.
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
        <StepUpField value={totpCode} onChange={setTotpCode} />
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
        <StepUpField value={totpCode} onChange={setTotpCode} />
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
