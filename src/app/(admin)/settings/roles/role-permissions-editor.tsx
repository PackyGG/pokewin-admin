"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { updateRolePermissions, type RoleConfig } from "./actions";
import {
  type CapabilityState,
  getCapabilityGroups,
} from "./permissions-utils";

const ROLES = ["support", "marketing", "creator", "pack_creator"] as const;

const ROLE_DESCRIPTIONS: Record<string, string> = {
  support: "Customer support — typically needs Users, Chat, Transactions",
  marketing: "Marketing team — typically needs Promo Codes, Gift Cards, Creators",
  creator: "Content creators — typically only needs My Profile",
  pack_creator:
    "Pack creator employee — only Packs page + Create Pack capability. Demo (inactive) packs are always editable; grant 'Edit Live Packs' if you want them to be able to change card pool / price / house edge on packs that are already live in production.",
};

/**
 * Per-role UI scope: hides capability groups + page entries that
 * the role has no business seeing, so the editor doesn't drown a
 * single-purpose role like `pack_creator` in irrelevant toggles.
 *
 * - `capabilityGroups` is matched by the `group` label on each
 *   capability spec (`permissions-utils.ts`).
 * - `pageKeys` is matched by the page's `key` from `admin-pages.ts`.
 *
 * `null` (or missing entry) → no scoping; render the full catalog,
 * matching the current behaviour for support / marketing / creator.
 *
 * Save semantics: out-of-scope keys already in the stored config are
 * preserved (we only operate on what the UI exposes). Select-All /
 * Select-None likewise only touch in-scope entries — they don't
 * blow away historical assignments.
 */
const ROLE_SCOPES: Record<
  string,
  { capabilityGroups: string[]; pageKeys: string[] } | null
> = {
  pack_creator: {
    capabilityGroups: ["Packs"],
    pageKeys: ["/packs"],
  },
  // Other roles: no scoping (full catalog).
  support: null,
  marketing: null,
  creator: null,
};

type GroupedPages = {
  group: string;
  pages: { key: string; label: string }[];
}[];

export function RolePermissionsEditor({
  groupedPages,
  initialPermissions,
}: {
  groupedPages: GroupedPages;
  initialPermissions: Record<string, RoleConfig>;
}) {
  const [activeRole, setActiveRole] = useState<string>(ROLES[0]);
  const [configs, setConfigs] = useState<Record<string, RoleConfig>>(
    initialPermissions,
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [savedConfigs] = useState<Record<string, RoleConfig>>(() =>
    JSON.parse(JSON.stringify(initialPermissions)),
  );

  const config = configs[activeRole] ?? {
    pages: [],
    capabilities: {},
  };
  const currentPages = new Set(config.pages);
  const capabilityGroups = getCapabilityGroups();

  // Apply the per-role scope (see ROLE_SCOPES above). For roles with
  // no scope, this is the identity transform — render everything.
  const scope = ROLE_SCOPES[activeRole] ?? null;
  const visibleCapabilityGroups = scope
    ? capabilityGroups.filter((g) => scope.capabilityGroups.includes(g.group))
    : capabilityGroups;
  const visiblePageGroups = scope
    ? groupedPages
        .map((g) => ({
          ...g,
          pages: g.pages.filter((p) => scope.pageKeys.includes(p.key)),
        }))
        .filter((g) => g.pages.length > 0)
    : groupedPages;
  // Badge + Select-All/None operate on the VISIBLE pages only so a
  // scoped role's "1/1 pages" stays meaningful and an admin can't
  // accidentally tick all 50 site pages for a pack_creator via the
  // "All" shortcut.
  const allPageKeys = visiblePageGroups.flatMap((g) =>
    g.pages.map((p) => p.key),
  );

  function hasChanges(role: string) {
    return JSON.stringify(configs[role]) !== JSON.stringify(savedConfigs[role]);
  }

  function updateConfig(partial: Partial<RoleConfig>) {
    setConfigs((prev) => ({
      ...prev,
      [activeRole]: { ...prev[activeRole], ...partial },
    }));
  }

  function updateCapability(capKey: string, partial: Partial<CapabilityState>) {
    setConfigs((prev) => {
      const current = prev[activeRole];
      return {
        ...prev,
        [activeRole]: {
          ...current,
          capabilities: {
            ...current.capabilities,
            [capKey]: { ...current.capabilities[capKey], ...partial },
          },
        },
      };
    });
  }

  function togglePage(pageKey: string) {
    const current = new Set(config.pages);
    if (current.has(pageKey)) {
      current.delete(pageKey);
    } else {
      current.add(pageKey);
    }
    updateConfig({ pages: [...current] });
  }

  function toggleGroup(group: GroupedPages[number]) {
    const current = new Set(config.pages);
    const groupKeys = group.pages.map((p) => p.key);
    const allChecked = groupKeys.every((k) => current.has(k));
    for (const k of groupKeys) {
      if (allChecked) {
        current.delete(k);
      } else {
        current.add(k);
      }
    }
    updateConfig({ pages: [...current] });
  }

  function selectAll() {
    if (scope) {
      // Scoped role: preserve any out-of-scope keys already stored
      // and only add the visible ones. Lets us narrow a role's UI
      // without wiping its historical access.
      const next = new Set(config.pages);
      for (const k of allPageKeys) next.add(k);
      updateConfig({ pages: [...next] });
    } else {
      updateConfig({ pages: [...allPageKeys] });
    }
  }

  function selectNone() {
    if (scope) {
      // Scoped role: only un-tick the visible pages; preserve
      // anything stored outside the scope.
      const visibleSet = new Set(allPageKeys);
      updateConfig({
        pages: config.pages.filter((k) => !visibleSet.has(k)),
      });
    } else {
      updateConfig({ pages: [] });
    }
  }

  function handleSave() {
    startTransition(async () => {
      try {
        const result = await updateRolePermissions(activeRole, config);
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

  // Badge shows visible-selected / visible-total so a scoped role's
  // "1 / 1 pages" reads naturally. For unscoped roles `allPageKeys`
  // covers the whole catalog, so this stays equivalent to the
  // previous `currentPages.size` / `allPageKeys.length`.
  const selectedCount = allPageKeys.filter((k) => currentPages.has(k)).length;
  const totalCount = allPageKeys.length;

  return (
    <div className="space-y-6">
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

      <p className="text-sm text-muted-foreground">
        {ROLE_DESCRIPTIONS[activeRole]}
      </p>

      {/* ── Capabilities ─────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Capabilities
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {visibleCapabilityGroups.map((group) => (
            <Card key={group.group}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">
                  {group.group}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {group.capabilities.map((cap) => {
                  const state = config.capabilities[cap.key] ?? {
                    enabled: false,
                  };
                  return (
                    <div key={cap.key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{cap.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {cap.description}
                          </p>
                        </div>
                        <Switch
                          checked={state.enabled}
                          onCheckedChange={(checked) =>
                            updateCapability(cap.key, {
                              enabled: !!checked,
                            })
                          }
                        />
                      </div>
                      {cap.key === "__can_adjust_balance" && state.enabled && (
                        <div className="rounded-md border border-dashed bg-muted/40 p-2.5 text-xs text-muted-foreground flex items-start gap-2">
                          <Info className="size-3.5 shrink-0 mt-0.5" />
                          <span>
                            Per-admin daily/weekly/monthly caps are set
                            individually on{" "}
                            <Link
                              href="/admin-users"
                              className="font-medium underline decoration-dotted hover:text-foreground"
                            >
                              Users (System)
                            </Link>{" "}
                            → user → Adjust Balance Limit. Without a
                            cap, this admin can adjust any amount.
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* ── Page Access ──────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Page Access
          </h2>
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
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visiblePageGroups.map((group) => {
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
                setConfigs((prev) => ({
                  ...prev,
                  [activeRole]: JSON.parse(
                    JSON.stringify(savedConfigs[activeRole] ?? { pages: [], capabilities: {} }),
                  ),
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
