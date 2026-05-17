"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updateUserPermissions } from "./actions";
import { PermissionPicker } from "../_components/permission-picker";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Permissions Section ──
 *
 * Edits the user's EFFECTIVE permission set — page access AND `__can_*`
 * action capabilities — stored in `allowed_pages`. When the user has a
 * role assigned, that role is the baseline and toggles differing from it
 * are flagged as per-user overrides (the "role + adjustments" model).
 *
 * `updateUserPermissions` requires TOTP, so changes are staged locally
 * and only persisted once the operator confirms with a 2FA code.
 */
export function PermissionsSection({ detail }: { detail: AdminUserDetail }) {
  // `savedKeys` mirrors the server; `selected` is the staged working copy.
  const [savedKeys, setSavedKeys] = useState<string[]>(detail.allowedPages);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(detail.allowedPages),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Role baseline — null when no role is assigned.
  const baseline =
    detail.roleCapabilities != null
      ? new Set(detail.roleCapabilities)
      : null;

  const savedSet = new Set(savedKeys);
  const isDirty =
    selected.size !== savedSet.size ||
    [...selected].some((k) => !savedSet.has(k));

  // Count of toggles that diverge from the assigned role.
  const overrideCount = baseline
    ? [...new Set([...selected, ...baseline])].filter(
        (k) => selected.has(k) !== baseline.has(k),
      ).length
    : 0;

  function discard() {
    setSelected(new Set(savedKeys));
    setTotpCode("");
    setConfirmOpen(false);
  }

  function save() {
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        await updateUserPermissions(detail.id, [...selected], totpCode.trim());
        toast.success("Permissions updated");
        setSavedKeys([...selected]);
        setConfirmOpen(false);
        setTotpCode("");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update permissions",
        );
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="text-base">Permissions</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {detail.roleName
              ? `Baseline from role "${detail.roleName}"` +
                (overrideCount > 0
                  ? ` · ${overrideCount} per-user override${overrideCount === 1 ? "" : "s"}`
                  : " · no overrides")
              : "No role assigned — permissions are fully per-user."}
          </p>
        </div>
        {isDirty && (
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={discard}
              disabled={isPending}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={isPending}
            >
              Save changes
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <PermissionPicker
          selected={selected}
          onChange={setSelected}
          disabled={isPending}
          baseline={baseline}
        />
      </CardContent>

      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) setTotpCode("");
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Save Permission Changes</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Granting or revoking permissions changes what this admin can do
              across the panel. Enter your 2FA code to confirm.
            </p>
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
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                setTotpCode("");
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={isPending || !totpCode.trim()}
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
