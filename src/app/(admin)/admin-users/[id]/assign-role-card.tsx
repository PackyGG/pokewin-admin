"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AdminRole } from "@/lib/dal";
import { RolesEditor } from "../_components/roles-editor";
import { setAdminRoles } from "../actions";

/**
 * "Roles" card on the admin-user profile.
 *
 * Edits the user's built-in SYSTEM roles (admin / support / marketing /
 * creator / pack_creator), stored on `admin_users.role` +
 * `admin_users.roles[]`. A user can hold several at once; their effective
 * access is the UNION of every role's baseline. Editing here reuses the
 * exact same chip editor + 2FA-gated `setAdminRoles` action that the
 * /admin-users list row uses, so adding a second role is one click + a
 * 2FA code. Saving is additive: it only ever GRANTS the new roles'
 * baselines onto the user's allowed_pages, never strips a manual grant.
 * The per-user grant/revoke editor lives in the Permissions section below
 * and is unaffected by this control.
 *
 * Hidden for real admins (they bypass every page / capability gate, so
 * roles-as-baseline is meaningless) — the parent only renders this card
 * when the user is not an admin.
 */
export function RolesCard({
  adminUserId,
  currentRoles,
  rolesColumnExists,
}: {
  adminUserId: string;
  /** The user's current effective SYSTEM roles (getEffectiveRoles result). */
  currentRoles: AdminRole[];
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
}) {
  const router = useRouter();

  // ── System-role editor state (chips + 2FA) ──
  const [selected, setSelected] = useState<Set<AdminRole>>(
    () => new Set(currentRoles),
  );
  const [totpCode, setTotpCode] = useState("");
  const [savingRoles, setSavingRoles] = useState(false);

  const currentRoleKey = [...currentRoles].sort().join(",");
  const pickedRoleKey = [...selected].sort().join(",");
  const rolesDirty = currentRoleKey !== pickedRoleKey;
  const rolesEmpty = selected.size === 0;

  const saveRolesDisabled =
    savingRoles || !totpCode.trim() || !rolesDirty || rolesEmpty;

  async function handleSaveRoles() {
    if (rolesEmpty || !rolesDirty) return;
    const code = totpCode.trim();
    if (!code) return;
    setSavingRoles(true);
    try {
      await setAdminRoles(adminUserId, [...selected], code);
      toast.success("Roles updated");
      setTotpCode("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update roles");
    } finally {
      setSavingRoles(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-amber-500" />
          Roles
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* System roles (multi-select chips + 2FA) */}
        <div className="space-y-3">
          <RolesEditor
            selected={selected}
            onChange={setSelected}
            rolesColumnExists={rolesColumnExists}
            disabled={savingRoles}
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
              disabled={savingRoles}
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSaveRoles}
              disabled={saveRolesDisabled}
            >
              {savingRoles ? "Saving..." : "Save roles"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
