"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  IdCard,
  Tv,
  Twitter,
  ShieldAlert,
  TrendingUp,
  Users,
  UsersRound,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

/**
 * Creator detail tab bar.
 *
 * Tab set (owner-confirmed): Overview · Creator · Sessions · Kick · Twitter ·
 * Risk · Forecast · Cohorts & LTV · Alt Accounts.
 *
 * NAVIGABLE this wave (drive the active tab via `?tab=`): Overview (default) ·
 * Creator · Risk · Forecast · Cohorts & LTV · Alt Accounts. These render as
 * `<Link replace>` chips that swap the URL's `tab` param — the page reads it and
 * mounts ONLY that tab's component lazily in a keyed Suspense boundary, so a
 * non-active tab never fetches its data (active-tab-only / never-preload).
 *
 * STILL "Soon" (later waves): Sessions · Kick · Twitter — rendered as inert,
 * non-navigating placeholders so the eventual structure is visible without dead
 * links and nothing extra is loaded.
 *
 * Mirrors the house tab-strip pattern (`insights/analytics` `InsightsTabNav`):
 * a client component that reads the current `?tab=` and highlights it, with the
 * same horizontal-scroller styling as before.
 */

type CreatorTab = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Placeholder (future wave) — rendered disabled, never navigates. */
  soon?: boolean;
};

/**
 * Tab keys that are navigable this wave. Kept private to this client component
 * (the server `page.tsx` mirrors the same set inline — a server import of a
 * value from this Client Component would throw at render). Order matters — it's
 * the on-screen left→right order of the live chips.
 */
const NAV_TABS = ["overview", "creator", "risk", "forecast", "cohorts", "alts"] as const;

/**
 * Coerce an arbitrary `?tab=` value to a navigable tab key, falling back to
 * Overview, so the highlighted chip always matches what the page renders (a
 * stale/unknown/"Soon" tab → Overview).
 */
function currentTabFrom(value: string | null): string {
  return (NAV_TABS as readonly string[]).includes(value ?? "") ? (value as string) : "overview";
}

const TABS: CreatorTab[] = [
  { key: "overview", label: "Overview", icon: TrendingUp },
  { key: "creator", label: "Creator", icon: IdCard },
  { key: "sessions", label: "Sessions", icon: BarChart3, soon: true },
  { key: "kick", label: "Kick", icon: Tv, soon: true },
  { key: "twitter", label: "Twitter", icon: Twitter, soon: true },
  { key: "risk", label: "Risk", icon: ShieldAlert },
  { key: "forecast", label: "Forecast", icon: CalendarClock },
  { key: "cohorts", label: "Cohorts & LTV", icon: UsersRound },
  { key: "alts", label: "Alt Accounts", icon: Users },
];

export function CreatorTabBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = currentTabFrom(searchParams.get("tab"));

  function hrefFor(tab: string): string {
    // Tab is the only URL slice this page uses; rebuild from scratch so no
    // stale param leaks across tabs.
    const p = new URLSearchParams();
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div
      role="tablist"
      aria-label="Creator detail sections"
      className="flex w-full items-center gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = !tab.soon && tab.key === current;

        // "Soon" tabs are inert placeholders (no link, no navigation).
        if (tab.soon) {
          return (
            <div
              key={tab.key}
              role="tab"
              aria-selected={false}
              aria-disabled
              title={`${tab.label} — coming in the next wave`}
              className="inline-flex shrink-0 cursor-default items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground/70"
            >
              <Icon className="size-4 text-muted-foreground/60" />
              <span>{tab.label}</span>
              <span className="ml-0.5 rounded-sm bg-muted px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                Soon
              </span>
            </div>
          );
        }

        return (
          <Link
            key={tab.key}
            href={hrefFor(tab.key)}
            replace
            prefetch={false}
            role="tab"
            aria-selected={isActive}
            title={tab.label}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground/70 hover:text-foreground",
            )}
          >
            <LinkPendingShell>
              <Icon
                className={cn(
                  "size-4",
                  isActive ? "text-pink-500" : "text-muted-foreground/60",
                )}
              />
              <span>{tab.label}</span>
            </LinkPendingShell>
          </Link>
        );
      })}
    </div>
  );
}
