"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StepUpField } from "@/components/step-up-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminRole } from "@/lib/dal";
import { Spinner } from "@/components/ux";
import { RolesEditor } from "../_components/roles-editor";
import { setAdminRoles } from "../actions";
import { assignRoleToAdminUser } from "../_roles/custom-roles-actions";

// Sentinel for the "no preset" option (base-ui Select can't use "" cleanly).
const PRESET_NONE = "__none__";

/**
 * "Roles" card on the admin-user profile — ONE Roles surface.
 *
 * Two complementary controls, both feeding the SAME materializer (their effects
 * union into the user's allowed_pages):
 *   1. System roles — the built-in enum roles (admin / support / marketing /
 *      creator / pack_creator / creator_manager) on `admin_users.role` +
 *      `roles[]`. Multi-select chips + 2FA-gated `setAdminRoles`.
 *   2. Role preset — an OPTIONAL assignable custom role (`admin_users.role_id`).
 *      Single-select + 2FA-gated `assignRoleToAdminUser`. Picking one
 *      materializes its capabilities into the user's allowed_pages (preserving
 *      their per-user adjustments); "No preset" clears the link.
 *
 * Never "built-in vs custom" — both are just Roles. Hidden for real admins by
 * the parent (they bypass every gate, so roles-as-baseline is meaningless).
 */
export function RolesCard({
  adminUserId,
  currentRoles,
  rolesColumnExists,
  assignablePresets,
  currentPresetId,
  currentPresetName,
}: {
  adminUserId: string;
  /** The user's current effective SYSTEM roles (getEffectiveRoles result). */
  currentRoles: AdminRole[];
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
  /** Assignable custom-role presets (id + name), for the preset select. */
  assignablePresets: { id: string; name: string }[];
  /** The user's currently-assigned preset (role_id), or null. */
  currentPresetId: string | null;
  /** The currently-assigned preset's display name, or null. */
  currentPresetName: string | null;
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

  // ── Role-preset state (single-select + 2FA) ──
  const [preset, setPreset] = useState<string>(currentPresetId ?? PRESET_NONE);
  const [presetCode, setPresetCode] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);

  const presetDirty = (currentPresetId ?? PRESET_NONE) !== preset;
  const savePresetDisabled = savingPreset || !presetCode.trim() || !presetDirty;

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

  async function handleSavePreset() {
    if (!presetDirty) return;
    const code = presetCode.trim();
    if (!code) return;
    setSavingPreset(true);
    try {
      const roleId = preset === PRESET_NONE ? null : preset;
      const res = await assignRoleToAdminUser(adminUserId, roleId, code);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(roleId ? "Preset assigned" : "Preset cleared");
      setPresetCode("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to assign preset");
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
      <CardContent className="space-y-6">
        {/* System roles (multi-select chips + 2FA) */}
        <div className="space-y-3">
          <RolesEditor
            selected={selected}
            onChange={setSelected}
            rolesColumnExists={rolesColumnExists}
            disabled={savingRoles}
          />
          <StepUpField
            value={totpCode}
            onChange={setTotpCode}
            disabled={savingRoles}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSaveRoles}
              disabled={saveRolesDisabled}
            >
              {savingRoles && <Spinner size={14} className="text-current" />}
              {savingRoles ? "Saving..." : "Save roles"}
            </Button>
          </div>
        </div>

        {/* Role preset (single-select custom role + 2FA) */}
        <div className="space-y-3 border-t pt-5">
          <div className="space-y-1">
            <Label className="flex items-center gap-1.5 text-sm font-medium">
              <Layers className="size-3.5 text-emerald-500" />
              Role preset
            </Label>
            <p className="text-[11px] text-muted-foreground">
              An optional reusable preset on top of the roles above. Assigning
              one grants its capabilities; manual per-user adjustments below are
              kept.
              {currentPresetName ? (
                <>
                  {" "}
                  Current:{" "}
                  <span className="font-medium text-foreground">
                    {currentPresetName}
                  </span>
                  .
                </>
              ) : null}
            </p>
          </div>
          {assignablePresets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No custom roles yet — create one from Admins &amp; Access →
              Roles.
            </p>
          ) : (
            <>
              <Select
                value={preset}
                onValueChange={(v) => setPreset(v ?? PRESET_NONE)}
              >
                <SelectTrigger
                  className="w-full"
                  disabled={savingPreset}
                  aria-label="Role preset"
                >
                  <SelectValue placeholder="No preset">
                    {(value: string) =>
                      !value || value === PRESET_NONE
                        ? "No preset"
                        : (assignablePresets.find((p) => p.id === value)?.name ??
                          "No preset")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={PRESET_NONE}>No preset</SelectItem>
                  {assignablePresets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <StepUpField
                value={presetCode}
                onChange={setPresetCode}
                disabled={savingPreset}
              />
              <div className="flex items-center justify-end gap-2">
                {preset !== PRESET_NONE && currentPresetId !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPreset(PRESET_NONE)}
                    disabled={savingPreset}
                  >
                    Unassign
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={handleSavePreset}
                  disabled={savePresetDisabled}
                >
                  {savingPreset && <Spinner size={14} className="text-current" />}
                  {savingPreset ? "Saving..." : "Save preset"}
                </Button>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
