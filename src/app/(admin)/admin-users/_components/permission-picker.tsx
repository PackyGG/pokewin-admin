"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import { getCapabilityGroups } from "@/app/(admin)/settings/roles/permissions-utils";

/**
 * Shared permission picker — the single editor surface for both a role's
 * capability set (/admin-users/roles/[id]) and a user's effective permissions
 * (/admin-users/[id]). Works in ONE vocabulary: page routes ("/users")
 * and `__can_*` capability flags — exactly what `allowed_pages` stores.
 *
 * `baseline` (optional): when editing a user who has a role assigned, pass
 * the role's permission set so toggles that differ from the role are
 * flagged as per-user overrides.
 *
 * Two render modes, additive + backward-compatible:
 *   • `control="checkbox"` (DEFAULT) — the original flat checkbox grid. The
 *     per-user override editor (`permissions-section.tsx`) uses this and is
 *     UNCHANGED.
 *   • `control="switch"` — collapsible Switch groups (one per page-group /
 *     capability-group). The role editor (RoleV2 P4) opts into this. Dead /
 *     unenforced caps (`deadCapKeys`) stay toggleable but carry a "not
 *     enforced yet" badge. `readOnly` renders every toggle non-interactive
 *     (the `admin` total-bypass view).
 */

type PickerGroup = {
  key: string;
  label: string;
  items: { key: string; label: string; description?: string }[];
};

// Pages grouped by their ADMIN_PAGES `group`, kept in first-seen order.
function pageGroups(): PickerGroup[] {
  const out: PickerGroup[] = [];
  const byGroup = new Map<string, PickerGroup>();
  for (const page of ADMIN_PAGES) {
    let group = byGroup.get(page.group);
    if (!group) {
      group = { key: `page:${page.group}`, label: page.group, items: [] };
      byGroup.set(page.group, group);
      out.push(group);
    }
    group.items.push({ key: page.key, label: page.label });
  }
  return out;
}

function capabilityGroups(): PickerGroup[] {
  return getCapabilityGroups().map((g) => ({
    key: `cap:${g.group}`,
    label: g.group,
    items: g.capabilities.map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description,
    })),
  }));
}

export function PermissionPicker({
  selected,
  onChange,
  disabled = false,
  baseline = null,
  control = "checkbox",
  deadCapKeys,
  readOnly = false,
}: {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  /** Role baseline — toggles differing from it are flagged as overrides. */
  baseline?: Set<string> | null;
  /** Control style. `"switch"` enables the grouped/collapsible role-editor UI. */
  control?: "checkbox" | "switch";
  /** Capability keys defined but not enforced yet (badged, still toggleable). */
  deadCapKeys?: ReadonlySet<string>;
  /** Render every toggle non-interactive (the `admin` read-only view). */
  readOnly?: boolean;
}) {
  const locked = disabled || readOnly;

  function toggle(key: string) {
    if (locked) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  function toggleGroup(keys: string[]) {
    if (locked) return;
    const next = new Set(selected);
    const allOn = keys.every((k) => next.has(k));
    for (const k of keys) {
      if (allOn) next.delete(k);
      else next.add(k);
    }
    onChange(next);
  }

  const sections: { title: string; groups: PickerGroup[] }[] = [
    { title: "Page Access", groups: pageGroups() },
    { title: "Capabilities", groups: capabilityGroups() },
  ];

  if (control === "switch") {
    return (
      <div className="space-y-6">
        {sections.map((section) => (
          <div key={section.title} className="space-y-3">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-2.5">
              {section.groups.map((group) => (
                <SwitchGroup
                  key={group.key}
                  group={group}
                  selected={selected}
                  baseline={baseline}
                  deadCapKeys={deadCapKeys}
                  locked={locked}
                  onToggle={toggle}
                  onToggleGroup={toggleGroup}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── Default checkbox grid (per-user override editor — unchanged) ──────────
  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <div key={section.title} className="space-y-3">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {section.title}
          </h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {section.groups.map((group) => {
              const keys = group.items.map((i) => i.key);
              const onCount = keys.filter((k) => selected.has(k)).length;
              const allOn = onCount === keys.length && keys.length > 0;
              const someOn = onCount > 0 && !allOn;
              return (
                <Card key={group.key}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={allOn}
                        indeterminate={someOn}
                        onCheckedChange={() => toggleGroup(keys)}
                        disabled={disabled}
                      />
                      <CardTitle className="min-w-0 flex-1 text-sm font-medium">
                        {group.label}
                      </CardTitle>
                      <span className="text-xs text-muted-foreground">
                        {onCount}/{keys.length}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2.5">
                    {group.items.map((item) => {
                      const checked = selected.has(item.key);
                      const isOverride =
                        baseline != null &&
                        checked !== baseline.has(item.key);
                      return (
                        <label
                          key={item.key}
                          className={cn(
                            "flex items-start gap-3",
                            disabled
                              ? "cursor-default"
                              : "group cursor-pointer",
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggle(item.key)}
                            disabled={disabled}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p
                                className={cn(
                                  "text-sm transition-colors",
                                  checked
                                    ? "text-foreground"
                                    : "text-muted-foreground group-hover:text-foreground",
                                )}
                              >
                                {item.label}
                              </p>
                              {isOverride && (
                                <Badge
                                  variant="outline"
                                  className="h-4 border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-600 dark:text-amber-400"
                                >
                                  {checked ? "added" : "removed"}
                                </Badge>
                              )}
                            </div>
                            {item.description && (
                              <p className="text-[11px] text-muted-foreground/80">
                                {item.description}
                              </p>
                            )}
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
                              {item.key}
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
      ))}
    </div>
  );
}

/**
 * One collapsible group of Switch toggles (page-group or capability-group).
 * Header shows on/off count + a master Switch that flips the whole group;
 * the body lists each token with a Switch, optional description, the raw key,
 * an override badge (vs baseline), and a "not enforced yet" badge for dead caps.
 */
function SwitchGroup({
  group,
  selected,
  baseline,
  deadCapKeys,
  locked,
  onToggle,
  onToggleGroup,
}: {
  group: PickerGroup;
  selected: Set<string>;
  baseline: Set<string> | null;
  deadCapKeys?: ReadonlySet<string>;
  locked: boolean;
  onToggle: (key: string) => void;
  onToggleGroup: (keys: string[]) => void;
}) {
  const keys = group.items.map((i) => i.key);
  const onCount = keys.filter((k) => selected.has(k)).length;
  const allOn = onCount === keys.length && keys.length > 0;
  // Open by default when the group has any enabled token, so the editor lands
  // showing what's granted; empty groups start collapsed to reduce noise.
  const [open, setOpen] = useState(onCount > 0);

  return (
    <div className="overflow-hidden rounded-lg border bg-card/40">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
          <span className="truncate text-sm font-medium">{group.label}</span>
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 px-1.5 text-[10px] font-medium",
              onCount > 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            {onCount}/{keys.length}
          </Badge>
        </button>
        <Switch
          checked={allOn}
          onCheckedChange={() => onToggleGroup(keys)}
          disabled={locked}
          aria-label={`Toggle all ${group.label}`}
        />
      </div>
      {open && (
        <div className="space-y-3 border-t px-3 py-3">
          {group.items.map((item) => {
            const checked = selected.has(item.key);
            const isOverride =
              baseline != null && checked !== baseline.has(item.key);
            const isDead = deadCapKeys?.has(item.key) ?? false;
            return (
              <div key={item.key} className="flex items-start gap-3">
                <Switch
                  checked={checked}
                  onCheckedChange={() => onToggle(item.key)}
                  disabled={locked}
                  className="mt-0.5"
                  aria-label={item.label}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p
                      className={cn(
                        "text-sm",
                        checked ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {item.label}
                    </p>
                    {isOverride && (
                      <Badge
                        variant="outline"
                        className="h-4 border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-600 dark:text-amber-400"
                      >
                        {checked ? "added" : "removed"}
                      </Badge>
                    )}
                    {isDead && (
                      <Badge
                        variant="outline"
                        className="h-4 border-muted-foreground/30 bg-muted/40 px-1 text-[9px] font-medium text-muted-foreground"
                        title="This capability is defined but not enforced in code yet."
                      >
                        not enforced yet
                      </Badge>
                    )}
                  </div>
                  {item.description && (
                    <p className="text-[11px] text-muted-foreground/80">
                      {item.description}
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
                    {item.key}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
