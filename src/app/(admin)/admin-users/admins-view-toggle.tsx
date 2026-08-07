"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ADMINS_VIEW_STORAGE_KEY,
  parseAdminsViewMode,
  type AdminsViewMode,
} from "./view-mode";

/**
 * Segmented view-toggle for the Admins list — Gallery (cards) vs Rows (table).
 *
 * URL-driven (`?view=gallery|rows`) so the choice survives in-page navigations
 * and is shareable, mirrored to localStorage so it also persists when the user
 * leaves and returns to a bare /admin-users URL (the list wrapper re-applies
 * the saved value on mount). Other search params (`?tab=`) are preserved on
 * every write.
 *
 * Two icon buttons rendered as a base-ui-styled segmented control — no new
 * primitive needed; matches the house tab-strip look (rounded border + muted
 * track, active chip raised with a shadow).
 *
 * Self-contained: reads the active view from `?view=` itself, so it can be
 * dropped straight into the server-rendered SectionHeading action with no
 * prop drilling.
 */
export function AdminsViewToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = parseAdminsViewMode(searchParams.get("view"));

  function go(next: AdminsViewMode) {
    if (next === current) return;
    // Persist for the next visit, then reflect into the URL (preserving any
    // other params, e.g. ?tab=admins). scroll:false keeps the list in place.
    try {
      window.localStorage.setItem(ADMINS_VIEW_STORAGE_KEY, next);
    } catch {
      // Private mode / disabled storage — URL still carries the choice.
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const options: {
    value: AdminsViewMode;
    label: string;
    icon: typeof LayoutGrid;
  }[] = [
    { value: "gallery", label: "Gallery", icon: LayoutGrid },
    { value: "rows", label: "Table", icon: Rows3 },
  ];

  return (
    <div
      role="group"
      aria-label="Switch admin list view"
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border bg-muted/50 p-1"
    >
      {options.map(({ value, label, icon: Icon }) => {
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => go(value)}
            aria-pressed={active}
            aria-label={`${label} view`}
            title={`${label} view`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

;
