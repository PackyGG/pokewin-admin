"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
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

const NONE = "__none__";

/**
 * "Role" card on the admin-user profile. Assigning a role materializes
 * its permission preset into the user's allowed_pages (the baseline);
 * the Permissions editor below then layers per-user grants/revokes on
 * top. Clearing the role keeps those manual grants. Hidden for real
 * admins (they have full access regardless).
 */
export function AssignRoleCard({
  adminUserId,
  currentRoleId,
}: {
  adminUserId: string;
  /** The user's current admin_users.role_id (null if none). */
  currentRoleId: string | null;
}) {
  const router = useRouter();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string>(currentRoleId ?? NONE);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    listRoles()
      .then((rows) => {
        setRoles(rows);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const dirty = (selected === NONE ? null : selected) !== currentRoleId;

  function handleSave() {
    startTransition(async () => {
      const result = await assignRoleToAdminUser(
        adminUserId,
        selected === NONE ? null : selected,
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        selected === NONE
          ? "Role cleared — manual grants kept"
          : "Role assigned — permissions below refreshed",
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-amber-500" />
          Role
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          A role fills this admin&apos;s permissions as a baseline. You can
          then grant or revoke individual permissions below — those
          adjustments survive a later role change.
        </p>
        {loaded && roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No roles yet.{" "}
            <Link
              href="/admin-users/roles"
              className="text-blue-400 hover:underline"
            >
              Create one
            </Link>{" "}
            to assign it here.
          </p>
        ) : (
          <>
            <Select
              value={selected}
              onValueChange={(v) => setSelected(v ?? NONE)}
              disabled={!loaded || isPending}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  <span className="text-muted-foreground">
                    No role (manual only)
                  </span>
                </SelectItem>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
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
