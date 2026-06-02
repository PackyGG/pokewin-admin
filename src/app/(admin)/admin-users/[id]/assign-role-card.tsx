"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { KeyRound, SlidersHorizontal } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminRole } from "@/lib/dal";
import { RolesEditor } from "../_components/roles-editor";
import { setAdminRoles } from "../actions";
import {
  listRoles,
  assignRoleToAdminUser,
  type RoleRow,
} from "@/app/(admin)/settings/roles/custom-roles-actions";

const NONE = "__none__";

/**
 * "Roles" card on the admin-user profile.
 *
 * PRIMARY control — the user's built-in SYSTEM roles (admin / support /
 * marketing / creator / pack_creator), stored on `admin_users.role` +
 * `admin_users.roles[]`. A user can hold several at once; their effective
 * access is the UNION of every role's baseline. Editing here reuses the
 * exact same chip editor + 2FA-gated `setAdminRoles` action that the
 * /admin-users list row uses, so adding a second role is one click + a
 * 2FA code. Saving is additive: it only ever GRANTS the new roles'
 * baselines onto the user's allowed_pages, never strips a manual grant.
 *
 * SECONDARY control — an optional custom permission PRESET
 * (`admin_users.role_id`, an `admin_roles` row created on /settings/roles).
 * This is a convenience layer that materializes a reusable set of pages /
 * capabilities into allowed_pages; it is NOT a system role and is kept
 * clearly separate + relabeled "Permission preset" so it can't be confused
 * with the system roles above (which was the original confusion). The
 * per-user grant/revoke editor lives in the Permissions section below and
 * is unaffected by either control.
 *
 * Hidden for real admins (they bypass every page / capability gate, so
 * neither roles-as-baseline nor a preset is meaningful) — the parent only
 * renders this card when the user is not an admin.
 */
export function RolesCard({
  adminUserId,
  currentRoles,
  currentRoleId,
  rolesColumnExists,
}: {
  adminUserId: string;
  /** The user's current effective SYSTEM roles (getEffectiveRoles result). */
  currentRoles: AdminRole[];
  /** The user's current custom-preset admin_users.role_id (null if none). */
  currentRoleId: string | null;
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

  // ── Custom permission-preset state (secondary control) ──
  const [presets, setPresets] = useState<RoleRow[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>(
    currentRoleId ?? NONE,
  );
  const [savingPreset, setSavingPreset] = useState(false);

  useEffect(() => {
    listRoles()
      .then((rows) => {
        setPresets(rows);
        setPresetsLoaded(true);
      })
      .catch(() => setPresetsLoaded(true));
  }, []);

  const presetDirty =
    (selectedPreset === NONE ? null : selectedPreset) !== currentRoleId;

  async function handleSavePreset() {
    setSavingPreset(true);
    try {
      const result = await assignRoleToAdminUser(
        adminUserId,
        selectedPreset === NONE ? null : selectedPreset,
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        selectedPreset === NONE
          ? "Preset cleared — manual grants kept"
          : "Preset applied — permissions below refreshed",
      );
      router.refresh();
    } finally {
      setSavingPreset(false);
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
        {/* ── PRIMARY: system roles (multi-select chips + 2FA) ── */}
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

        {/* ── SECONDARY: optional custom permission preset (role_id) ── */}
        <div className="space-y-2.5 border-t border-border/60 pt-4">
          <div className="space-y-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <SlidersHorizontal className="size-3.5 text-muted-foreground" />
              Permission preset
            </span>
            <p className="text-xs text-muted-foreground">
              Optional. Applies a reusable set of pages &amp; capabilities (a
              custom role from{" "}
              <Link
                href="/settings/roles"
                className="text-blue-400 hover:underline"
              >
                Settings → Roles
              </Link>
              ) onto this admin&apos;s permissions. This is not a system role —
              it&apos;s a convenience baseline. Manual grants below are kept.
            </p>
          </div>
          {presetsLoaded && presets.length === 0 ? (
            <EmptyState
              icon={SlidersHorizontal}
              title="No presets yet"
              description={
                <>
                  <Link
                    href="/settings/roles"
                    className="text-blue-400 hover:underline"
                  >
                    Create one
                  </Link>{" "}
                  to apply it here.
                </>
              }
              compact
            />
          ) : (
            <>
              <Select
                value={selectedPreset}
                onValueChange={(v) => setSelectedPreset(v ?? NONE)}
                disabled={!presetsLoaded || savingPreset}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    <span className="text-muted-foreground">
                      No preset (manual only)
                    </span>
                  </SelectItem>
                  {presets.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSavePreset}
                  disabled={!presetDirty || savingPreset}
                >
                  {savingPreset ? "Saving..." : "Apply preset"}
                </Button>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
