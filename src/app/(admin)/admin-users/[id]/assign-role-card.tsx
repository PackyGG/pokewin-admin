"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listRoles,
  assignRoleToAdminUser,
  type RoleRow,
} from "../roles/actions";

/**
 * Standalone "Assign custom role" card. Designed to be dropped into the
 * admin-user detail page (e.g. the Management tab in admin-user-tabs.tsx).
 *
 * Uses the NEW granular-permissions system: sets admin_users.role_id via
 * assignRoleToAdminUser(). Independent of the legacy enum `role` column.
 *
 * Gracefully no-ops with a hint message before `admin:migrate` + `admin:seed`.
 */
export function AssignRoleCard({
  adminUserId,
  currentRoleId,
}: {
  adminUserId: string;
  /** The current admin_users.role_id (null if unset). */
  currentRoleId: string | null;
}) {
  const router = useRouter();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string>(currentRoleId ?? "__none__");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    listRoles()
      .then((rows) => {
        setRoles(rows);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const dirty = (selected === "__none__" ? null : selected) !== currentRoleId;

  function handleSave() {
    startTransition(async () => {
      const result = await assignRoleToAdminUser(
        adminUserId,
        selected === "__none__" ? null : selected,
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Custom role assigned");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom Role</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Granular role assignment. Takes precedence over the enum role when set.
          Clear to fall back to system defaults.
        </p>
        {loaded && roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No roles available. Run{" "}
            <code className="text-xs">npm run admin:migrate</code> and{" "}
            <code className="text-xs">npm run admin:seed</code>, then visit{" "}
            <code className="text-xs">/admin-users/roles</code>.
          </p>
        ) : (
          <>
            <Select
              value={selected}
              onValueChange={(v) => setSelected(v ?? "__none__")}
              disabled={!loaded || isPending}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  <span className="text-muted-foreground">
                    None (system defaults)
                  </span>
                </SelectItem>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                    {r.is_system ? (
                      <span className="text-xs text-muted-foreground"> (system)</span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!dirty || isPending}
              >
                {isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
