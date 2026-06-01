"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * URL-driven Grid / List view switcher for /creators. Toggles how the
 * creator roster renders:
 *   • grid — self-contained cards (default, no `?view` param)
 *   • list — compact one-creator-per-row table for fast scanning
 *
 * Unlike the Fill / Multiplier tab switch (which deliberately drops
 * search / sort / page because the two pools diverge), the view toggle
 * is a pure presentation change over the SAME data — so it PRESERVES
 * every other param (`tab`, `search`, `page`, `sortBy`, `perPage`,
 * `filter`) and only adds / clears `view`. We clone the live
 * searchParams and mutate just that one key, mirroring the param-clone
 * pattern in <DataTableToolbar>.
 *
 * Plain `<Link replace>` (not router state) so the choice survives a
 * reload and ⌘-click works, but flipping the view doesn't pollute
 * browser history. Client-safe: imports only `cn`, `next/navigation`,
 * and lucide icons — no server query-module value imports (those break
 * the turbopack client build).
 */

const VIEWS = [
  { value: "grid", label: "Grid view", Icon: LayoutGrid },
  { value: "list", label: "List view", Icon: List },
] as const;

export function CreatorsViewToggle() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("view") === "list" ? "list" : "grid";

  function hrefFor(view: "grid" | "list"): string {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "grid") {
      // grid is the default — keep the URL clean by dropping the param.
      params.delete("view");
    } else {
      params.set("view", view);
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div
      role="tablist"
      aria-label="Creator list view"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {VIEWS.map(({ value, label, Icon }) => {
        const active = current === value;
        return (
          <Link
            key={value}
            href={hrefFor(value)}
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            // `replace` so flipping the view doesn't stack history
            // entries, but reload + ⌘-click still work (real nav).
            replace
            scroll={false}
            className={cn(
              "inline-flex items-center justify-center rounded-md p-1.5 transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </Link>
        );
      })}
    </div>
  );
}
