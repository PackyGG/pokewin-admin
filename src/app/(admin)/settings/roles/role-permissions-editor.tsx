"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { updateRolePermissions } from "./actions";

const ROLES = ["support", "marketing", "creator"] as const;

const ROLE_DESCRIPTIONS: Record<string, string> = {
  support: "Customer support — typically needs Users, Chat, Transactions",
  marketing: "Marketing team — typically needs Promo Codes, Gift Cards, Creators",
  creator: "Content creators — typically only needs My Profile",
};

type GroupedPages = {
  group: string;
  pages: { key: string; label: string }[];
}[];

type Permissions = Record<string, string[]>;

export function RolePermissionsEditor({
  groupedPages,
  initialPermissions,
}: {
  groupedPages: GroupedPages;
  initialPermissions: Permissions;
}) {
  const [activeRole, setActiveRole] = useState<string>(ROLES[0]);
  const [permissions, setPermissions] = useState<Permissions>(initialPermissions);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Track which roles have unsaved changes
  const [savedPermissions] = useState<Permissions>(() =>
    JSON.parse(JSON.stringify(initialPermissions)),
  );

  const currentPages = new Set(permissions[activeRole] ?? []);
  const allPageKeys = groupedPages.flatMap((g) => g.pages.map((p) => p.key));

  function hasChanges(role: string) {
    const current = [...(permissions[role] ?? [])].sort();
    const saved = [...(savedPermissions[role] ?? [])].sort();
    return JSON.stringify(current) !== JSON.stringify(saved);
  }

  function togglePage(pageKey: string) {
    setPermissions((prev) => {
      const current = new Set(prev[activeRole] ?? []);
      if (current.has(pageKey)) {
        current.delete(pageKey);
      } else {
        current.add(pageKey);
      }
      return { ...prev, [activeRole]: [...current] };
    });
  }

  function toggleGroup(group: GroupedPages[number]) {
    setPermissions((prev) => {
      const current = new Set(prev[activeRole] ?? []);
      const groupKeys = group.pages.map((p) => p.key);
      const allChecked = groupKeys.every((k) => current.has(k));
      for (const k of groupKeys) {
        if (allChecked) {
          current.delete(k);
        } else {
          current.add(k);
        }
      }
      return { ...prev, [activeRole]: [...current] };
    });
  }

  function selectAll() {
    setPermissions((prev) => ({
      ...prev,
      [activeRole]: [...allPageKeys],
    }));
  }

  function selectNone() {
    setPermissions((prev) => ({
      ...prev,
      [activeRole]: [],
    }));
  }

  function handleSave() {
    startTransition(async () => {
      try {
        const result = await updateRolePermissions(
          activeRole,
          permissions[activeRole] ?? [],
        );
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success(
          `Permissions updated for ${activeRole} (all users of this role)`,
        );
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to update permissions",
        );
      }
    });
  }

  const selectedCount = currentPages.size;
  const totalCount = allPageKeys.length;

  return (
    <div className="space-y-4">
      {/* Role tabs */}
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {ROLES.map((role) => (
          <button
            key={role}
            onClick={() => setActiveRole(role)}
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition-colors capitalize relative",
              activeRole === role
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {role}
            {hasChanges(role) && (
              <span className="absolute top-1 right-1 size-2 rounded-full bg-amber-500" />
            )}
          </button>
        ))}
      </div>

      {/* Role description + quick actions */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {ROLE_DESCRIPTIONS[activeRole]}
        </p>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {selectedCount}/{totalCount} pages
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={selectAll}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={selectNone}
          >
            None
          </Button>
        </div>
      </div>

      {/* Page groups */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groupedPages.map((group) => {
          const groupKeys = group.pages.map((p) => p.key);
          const checkedCount = groupKeys.filter((k) =>
            currentPages.has(k),
          ).length;
          const allGroupChecked = checkedCount === groupKeys.length;
          const someGroupChecked = checkedCount > 0 && !allGroupChecked;

          return (
            <Card key={group.group}>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={allGroupChecked}
                    indeterminate={someGroupChecked}
                    onCheckedChange={() => toggleGroup(group)}
                  />
                  <CardTitle className="text-sm font-medium">
                    {group.group}
                  </CardTitle>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {checkedCount}/{groupKeys.length}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {group.pages.map((page) => {
                  const isChecked = currentPages.has(page.key);
                  return (
                    <label
                      key={page.key}
                      className="flex items-center gap-3 cursor-pointer group"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => togglePage(page.key)}
                      />
                      <span
                        className={cn(
                          "text-sm transition-colors",
                          isChecked
                            ? "text-foreground"
                            : "text-muted-foreground group-hover:text-foreground",
                        )}
                      >
                        {page.label}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground font-mono truncate max-w-[120px]">
                        {page.key}
                      </span>
                    </label>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Save bar */}
      {hasChanges(activeRole) && (
        <div className="sticky bottom-4 flex items-center justify-between rounded-lg border bg-card p-4 shadow-lg">
          <p className="text-sm">
            Unsaved changes for{" "}
            <span className="font-medium capitalize">{activeRole}</span> role
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setPermissions((prev) => ({
                  ...prev,
                  [activeRole]: [...(savedPermissions[activeRole] ?? [])],
                }))
              }
              disabled={isPending}
            >
              Discard
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
