"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import { ALL_PERMISSION_KEYS } from "@/app/(admin)/settings/roles/permissions-utils";
import { PermissionPicker } from "@/app/(admin)/admin-users/_components/permission-picker";
import { updateRole, deleteRole, type RoleRow } from "./custom-roles-actions";

export function RoleEditor({ role }: { role: RoleRow }) {
  const router = useRouter();

  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(role.capabilities),
  );
  const [isPending, startTransition] = useTransition();

  const savedSnapshot = JSON.stringify({
    name: role.name,
    description: role.description ?? "",
    capabilities: [...role.capabilities].sort(),
  });
  const currentSnapshot = JSON.stringify({
    name,
    description,
    capabilities: [...selected].sort(),
  });
  const dirty = savedSnapshot !== currentSnapshot;

  function handleSave() {
    startTransition(async () => {
      const result = await updateRole({
        id: role.id,
        name,
        description: description.trim() || null,
        capabilities: [...selected],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(
        role.user_count > 0
          ? `Role updated — ${role.user_count} assigned user(s) refreshed`
          : "Role updated",
      );
      router.refresh();
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteRole(role.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Role deleted");
      router.push("/settings/roles");
    });
  }

  return (
    <div className="space-y-6">
      {/* Metadata */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Users with this role</Label>
              <div className="flex h-9 items-center text-sm text-muted-foreground">
                {role.user_count} assigned
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-description">Description</Label>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              disabled={isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Permission grid */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Permissions
          </h2>
          <Badge variant="outline" className="text-xs">
            {selected.size}/{ALL_PERMISSION_KEYS.length} selected
          </Badge>
        </div>
        <PermissionPicker
          selected={selected}
          onChange={setSelected}
          disabled={isPending}
        />
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <AlertDialog>
          <AlertDialogTrigger
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
            )}
            disabled={isPending}
          >
            <Trash2 className="size-4" />
            Delete role
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete role &quot;{role.name}&quot;?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {role.user_count > 0
                  ? `${role.user_count} user(s) will lose this role link. They keep their current effective permissions — you can assign a different role any time.`
                  : "This cannot be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-xs text-amber-500">Unsaved changes</span>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || isPending || !name.trim()}
          >
            {isPending ? (
              <Spinner size={16} className="text-current" />
            ) : (
              <Save className="size-4" />
            )}
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
