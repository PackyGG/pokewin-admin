"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Users,
  Filter,
  TrendingUp,
  Percent,
  PieChart,
  Trophy,
  Clock,
  Package,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type AnalyticsTab =
  | "overview"
  | "cohorts"
  | "funnel"
  | "ltv"
  | "retention"
  | "revenue"
  | "top"
  | "heatmap"
  | "packs";

const TABS: { value: AnalyticsTab; label: string; icon: typeof BarChart3 }[] = [
  { value: "overview", label: "Overview", icon: BarChart3 },
  { value: "cohorts", label: "Cohorts", icon: Users },
  { value: "funnel", label: "Funnel", icon: Filter },
  { value: "ltv", label: "Creator LTV", icon: TrendingUp },
  { value: "retention", label: "Retention", icon: Percent },
  { value: "revenue", label: "Revenue", icon: PieChart },
  { value: "top", label: "Top Performers", icon: Trophy },
  { value: "heatmap", label: "Activity Heatmap", icon: Clock },
  { value: "packs", label: "Pack & Battle", icon: Package },
];

/**
 * Horizontal tab nav that persists the active tab in `?tab=` so deep links
 * land on the right panel. Other query params (period etc.) are preserved
 * across tab switches.
 *
 * Mobile UX:
 *   - Tabs are wider than a phone (9 chips × ~110px ≈ 990px), so the
 *     row stays horizontally scrollable on touch — but on phones it's
 *     unclear whether more content lives off-screen. We layer two
 *     gradient fades on the left/right edges that hint at scrollable
 *     content; they're absolutely positioned and pointer-events-none
 *     so they never block taps. Hidden at sm+ where 9 chips fit on a
 *     normal viewport.
 *   - Active chip is `scroll-mx-2` so when the page mounts mid-scroll
 *     the active tab still has breathing room from the fade overlay.
 */
export function AnalyticsTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "overview") as AnalyticsTab;

  function hrefFor(tab: AnalyticsTab): string {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div className="relative">
      <div className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map(({ value, label, icon: Icon }) => (
          <Link
            key={value}
            href={hrefFor(value)}
            replace
            prefetch={false}
            className={cn(
              "flex shrink-0 scroll-mx-2 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              current === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        ))}
      </div>
      {/* Edge fades — only meaningful on phones where the tab list
          overflows. At lg+ all 9 chips fit so the gradients are noise. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-lg bg-gradient-to-r from-background to-transparent lg:hidden"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-lg bg-gradient-to-l from-background to-transparent lg:hidden"
      />
    </div>
  );
}
