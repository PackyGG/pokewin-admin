"use client";

import * as React from "react";
import { LayoutGrid, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUrlParam } from "@/lib/entity-surface/use-url-state";
import { type EntityView, resolveEntityView } from "./view";

// Re-export the server-safe view vocabulary so existing importers of this
// module keep working. The pure pieces are DEFINED in `./view` (a
// directive-free module) so server components can call `resolveEntityView`
// without invoking a client function — see that file's header.
;

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  EntityViewToggle  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * URL-driven grid ⇄ table (⇄ …) segmented toggle for an operational list
 * surface. The discovery maps want a dense sortable TABLE as the primary
 * triage view with the existing card-GRID kept as a secondary "gallery" view
 * — one click apart, nothing lost. This is that switch.
 *
 * State lives in `?view=` so the chosen view survives reload + ⌘-click and the
 * server can render the right primitive directly (no flash of the wrong view).
 * Switching the view does NOT reset the page/filters (it's a presentation
 * change, not a result-set change) — `useUrlParam` defaults `resetPage:false`.
 *
 * Visual vocabulary matches the existing tab-pill switches (PacksTabSwitch /
 * cards-tab-switch): a bordered `bg-muted/30` track with a raised active pill.
 */

const ENTITY_VIEW_OPTIONS: ReadonlyArray<{
  value: EntityView;
  label: string;
  icon: React.ElementType;
}> = [
  { value: "table", label: "Table", icon: Table2 },
  { value: "grid", label: "Gallery", icon: LayoutGrid },
];

export function EntityViewToggle({
  paramKey = "view",
  className,
}: {
  paramKey?: string;
  className?: string;
}) {
  const [value, setValue, isPending] = useUrlParam(paramKey, {
    defaultValue: "table",
  });
  const active = resolveEntityView(value);

  return (
    <div
      role="tablist"
      aria-label="List view"
      className={cn(
        "inline-flex shrink-0 items-center rounded-lg border border-border/60 bg-muted/30 p-0.5",
        className,
      )}
    >
      {ENTITY_VIEW_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const isActive = active === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={isPending}
            onClick={() => setValue(opt.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-70 sm:text-sm",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
