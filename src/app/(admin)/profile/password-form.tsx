"use client";

import { useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import { Spinner } from "@/components/ux";
import { changeOwnPassword } from "./password-actions";

const MIN_PASSWORD_LENGTH = 10;

/**
 * Self-service "Change Password" form for the currently-logged-in admin.
 * Mirrors the house pattern in profile-form.tsx: shadcn primitives, sonner
 * toasts, the shared <Spinner>, and the standard try/catch/finally flow.
 * Every field is a password input except the 2FA code (numeric). The server
 * action enforces all security (current-password check + mandatory TOTP);
 * the light client-side checks here only save an obviously-doomed round-trip.
 */
export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setTwoFactorCode("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Preliminary client checks — the server re-validates everything.
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation do not match");
      return;
    }
    if (newPassword === currentPassword) {
      toast.error("New password must be different from your current password");
      return;
    }
    // Either a 6-digit TOTP or a passkey step-up proof token satisfies the
    // gate; require2FA validates the real format server-side. Client-side we
    // only require a non-empty value.
    if (!twoFactorCode.trim()) {
      toast.error("Enter your 2FA code, or verify with a passkey");
      return;
    }

    setSaving(true);
    try {
      await changeOwnPassword({
        currentPassword,
        newPassword,
        confirmPassword,
        twoFactorCode: twoFactorCode.trim(),
      });
      toast.success("Password changed");
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={saving}
        />
      </div>

      {/* New + confirm sit side-by-side on wider layouts (the profile dialog
          hands this form a roomy column) and stack on phones. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters. Must differ from your
            current password.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            disabled={saving}
          />
        </div>
      </div>

      <div className="space-y-2">
        <StepUpField
          value={twoFactorCode}
          onChange={setTwoFactorCode}
          disabled={saving}
        />
        <p className="text-xs text-muted-foreground">
          Confirm with your current 6-digit authenticator code, or a passkey.
        </p>
      </div>

      <Button
        type="submit"
        size="sm"
        disabled={
          saving ||
          currentPassword === "" ||
          newPassword === "" ||
          confirmPassword === "" ||
          twoFactorCode.trim() === ""
        }
      >
        {saving ? (
          <Spinner size={14} className="text-current" />
        ) : (
          <KeyRound className="size-4" />
        )}
        {saving ? "Changing..." : "Change password"}
      </Button>
    </form>
  );
}
