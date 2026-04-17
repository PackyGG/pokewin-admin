"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { CAPABILITIES } from "@/lib/permissions";
import { updateRole, deleteRole, type RoleRow } from "./actions";

export function RoleEditor({ role }: { role: RoleRow }) {
  const router = useRouter();
  const readOnly = role.is_system;

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

  function toggle(key: string) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleDomain(domainKeys: readonly string[]) {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allChecked = domainKeys.every((k) => next.has(k));
      for (const k of domainKeys) {
        if (allChecked) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

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
      toast.success("Role updated");
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
      router.push("/admin-users/roles");
    });
  }

  const totalCaps = CAPABILITIES.reduce((n, d) => n + d.capabilities.length, 0);
  const selectedCount = selected.size;

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
                disabled={readOnly || isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Users with this role</Label>
              <div className="h-9 flex items-center text-sm text-muted-foreground">
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
              disabled={readOnly || isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Capabilities grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Capabilities
          </h2>
          <Badge variant="outline" className="text-xs">
            {selectedCount}/{totalCaps} selected
          </Badge>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((group) => {
            const keys = group.capabilities.map((c) => c.key);
            const checkedCount = keys.filter((k) => selected.has(k)).length;
            const allChecked = checkedCount === keys.length;
            const someChecked = checkedCount > 0 && !allChecked;
            return (
              <Card key={group.domain}>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={allChecked}
                      indeterminate={someChecked}
                      onCheckedChange={() => toggleDomain(keys)}
                      disabled={readOnly || isPending}
                    />
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-sm font-medium">
                        {group.label}
                      </CardTitle>
                      {group.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {group.description}
                        </p>
                      )}
                    </div>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {checkedCount}/{keys.length}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  {group.capabilities.map((cap) => {
                    const checked = selected.has(cap.key);
                    return (
                      <label
                        key={cap.key}
                        className={cn(
                          "flex items-start gap-3",
                          readOnly ? "cursor-default" : "cursor-pointer group",
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggle(cap.key)}
                          disabled={readOnly || isPending}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              "text-sm transition-colors",
                              checked
                                ? "text-foreground"
                                : "text-muted-foreground group-hover:text-foreground",
                            )}
                          >
                            {cap.label}
                          </p>
                          <p className="text-[11px] text-muted-foreground/80">
                            {cap.description}
                          </p>
                          <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                            {cap.key}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-3 border-t pt-4">
        {readOnly ? (
          <p className="text-sm text-muted-foreground">
            System roles are read-only. Create a custom role to define your own
            capability set.
          </p>
        ) : (
          <>
            <AlertDialog>
              <AlertDialogTrigger
                className={cn(
                  "inline-flex items-center gap-2 h-8 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
                )}
                disabled={isPending}
              >
                <Trash2 className="size-4" />
                Delete role
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete role &quot;{role.name}&quot;?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {role.user_count > 0
                      ? `This role is still assigned to ${role.user_count} user(s). Reassign them first.`
                      : "This cannot be undone."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    disabled={role.user_count > 0}
                  >
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
                <Save className="size-4" />
                {isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
