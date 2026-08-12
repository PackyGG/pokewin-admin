"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  BarChart3,
  ClipboardList,
  Crown,
  IdCard,
  ShieldAlert,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";

/**
 * Creator detail tab bar.
 *
 * Tab set: Overview · Creator · Sessions · Risk · Rewards · Alt Accounts · Audit.
 *
 * All tabs drive the active tab via `?tab=`: the page reads it and mounts
 * ONLY that tab's component lazily in a keyed Suspense boundary, so a
 * non-active tab never fetches its data (active-tab-only / never-preload).
 * Overview is the default for a missing/unknown `?tab=`.
 *
 * Switching tabs PRESERVES the other URL params (`?activityPeriod=`,
 * `?sessionsPage=`) instead of rebuilding the query from scratch — a period
 * or page you picked survives a round-trip through another tab (non-owning
 * tabs simply ignore them; nothing 404s or misleads).
 *
 * Navigation uses the dashboard's `useTransition` + `router.replace(...,
 * { scroll: false })` mechanic (not a plain `<Link>`): the transition keeps the
 * CURRENT tab's content mounted (dimmed, with an in-chip spinner) while the
 * next tab streams in, so switching no longer blanks to the skeleton. Other
 * tabs stay clickable during a pending switch, and hover/focus prefetches the
 * target so the click lands warm.
 */

type CreatorTab = {
  key: string;
  label: string;
  icon: LucideIcon;
};

/**
 * Navigable tab keys. Kept private to this client component (the server
 * `page.tsx` mirrors the same set inline — a server import of a value from
 * this Client Component would throw at render). Order matters — it's the
 * on-screen left→right order of the chips.
 */
const NAV_TABS = [
  "overview",
  "creator",
  "sessions",
  "risk",
  "rewards",
  "alts",
  "audit",
] as const;

/**
 * Coerce an arbitrary `?tab=` value to a navigable tab key, falling back to
 * Overview, so the highlighted chip always matches what the page renders.
 */
function currentTabFrom(value: string | null): string {
  return (NAV_TABS as readonly string[]).includes(value ?? "") ? (value as string) : "overview";
}

const TABS: CreatorTab[] = [
  { key: "overview", label: "Overview", icon: TrendingUp },
  { key: "creator", label: "Creator", icon: IdCard },
  { key: "sessions", label: "Sessions", icon: BarChart3 },
  { key: "risk", label: "Risk", icon: ShieldAlert },
  { key: "rewards", label: "Rewards", icon: Crown },
  { key: "alts", label: "Alt Accounts", icon: Users },
  { key: "audit", label: "Audit", icon: ClipboardList },
];

export function CreatorTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = currentTabFrom(searchParams.get("tab"));
  const [isPending, startTransition] = useTransition();

  function hrefFor(tab: string): string {
    // Preserve the existing params (activityPeriod, sessionsPage, …) and
    // swap only the tab — non-owning tabs ignore what isn't theirs, so
    // nothing goes stale or misleads.
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  function go(tab: string) {
    if (tab === current) return;
    startTransition(() => {
      router.replace(hrefFor(tab), { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Creator detail sections"
      className="flex w-full items-center gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.key === current;

        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => go(tab.key)}
            onMouseEnter={() => router.prefetch(hrefFor(tab.key))}
            onFocus={() => router.prefetch(hrefFor(tab.key))}
            disabled={isActive}
            role="tab"
            aria-selected={isActive}
            title={tab.label}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground/70 hover:text-foreground",
              isPending && !isActive && "opacity-50",
            )}
          >
            {isActive && isPending ? (
              <Spinner size={16} label={`Loading ${tab.label}`} />
            ) : (
              <Icon
                className={cn(
                  "size-4",
                  isActive ? "text-pink-500" : "text-muted-foreground/60",
                )}
              />
            )}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
