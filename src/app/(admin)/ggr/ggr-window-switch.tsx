"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

/**
 * URL-driven window switcher for /ggr — 24h / 3d / 7d.
 *
 * Mirrors the pattern on /creators (`creators-tab-switch.tsx`): plain
 * `<Link>` (not router.replace) so the active window survives reload and
 * ⌘-click into a new tab works. The active window is read from the
 * `?window=` URL param; the default (`24h`) carries no param so a bare
 * `/ggr` deep-link lands on it.
 *
 * Each tab swap is a real navigation so the server component re-runs
 * `getGgrPageData(window)` + `getGgrTopContributors(window, 10)` (from
 * `@/lib/queries/ggr`) for the new window — the canonical metric reads
 * keep the round-trip cheap when admins flip between windows.
 */

const WINDOWS = [
  { value: "24h", label: "Last 24h" },
  { value: "3d", label: "Last 3 days" },
  { value: "7d", label: "Last 7 days" },
] as const;

export type GgrWindowValue = (typeof WINDOWS)[number]["value"];

export function GgrWindowSwitch() {
  const searchParams = useSearchParams();
  // Anything other than the three supported values normalises to the
  // default — mirrors the server-side coercion in the page.
  const raw = searchParams.get("window");
  const current: GgrWindowValue =
    raw === "3d" || raw === "7d" ? raw : "24h";

  return (
    <div
      role="tablist"
      aria-label="GGR window"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {WINDOWS.map(({ value, label }) => {
        const active = current === value;
        const href = value === "24h" ? "/ggr" : `/ggr?window=${value}`;
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            // `replace` so the window switch doesn't pollute browser
            // history with every flip, but reload + ⌘-click still work
            // because it's a real navigation.
            replace
            scroll={false}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LinkPendingShell>{label}</LinkPendingShell>
          </Link>
        );
      })}
    </div>
  );
}
