"use client";

import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreatorsView } from "./creators-view-context";

/**
 * Grid / List view switcher for /creators. Toggles how the creator
 * roster renders:
 *   • grid — self-contained cards (default)
 *   • list — compact one-creator-per-row table for fast scanning
 *
 * The view is pure presentation over the SAME already-fetched data, so
 * the toggle is client state (via <CreatorsViewProvider>) — NOT a URL
 * param. Clicking flips `view` instantly with no navigation, no refetch,
 * and no Suspense skeleton; the choice persists in localStorage. See
 * creators-view-context.tsx for the rationale.
 *
 * Client-safe: imports only `cn`, lucide icons, and the view context —
 * no server query-module value imports (those break the turbopack
 * client build).
 */

const VIEWS = [
  { value: "grid", label: "Grid view", Icon: LayoutGrid },
  { value: "list", label: "List view", Icon: List },
] as const;

export function CreatorsViewToggle() {
  const { view, setView } = useCreatorsView();

  return (
    <div
      role="tablist"
      aria-label="Creator list view"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {VIEWS.map(({ value, label, Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => setView(value)}
            className={cn(
              "inline-flex items-center justify-center rounded-md p-1.5 transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
