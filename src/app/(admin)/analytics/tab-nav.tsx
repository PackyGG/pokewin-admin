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
  Coins,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type AnalyticsTab =
  | "overview"
  | "pure-pnl"
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
  // Raw pack/battle gambling margin — separate from Overview's broader
  // realized + windowed P&L panels so admins can deep-link the
  // real-money-only gameplay outcome view without scrolling past the
  // rest. Excludes creator wagers AND borrow-mode plays.
  { value: "pure-pnl", label: "Raw P&L", icon: Coins },
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
 *     unclear whether more content lives off-screen. We fade the strip's
 *     own edges to transparent with a horizontal `mask-image` gradient,
 *     so off-screen chips dissolve at both edges regardless of what sits
 *     behind the strip (no background-color matching needed, unlike an
 *     overlay div). The mask is dropped at lg+ where all 9 chips fit.
 *   - `overscroll-x-contain` keeps the momentum swipe inside the strip
 *     instead of bouncing the whole page.
 *   - Active chip is `scroll-mx-4` so when the page mounts mid-scroll the
 *     active tab still clears the faded edge.
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
    <div
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        // Fade both edges to transparent on phones to signal more chips
        // off-screen; removed at lg+ where the full strip is visible.
        "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
        "lg:[mask-image:none]",
      )}
    >
      {TABS.map(({ value, label, icon: Icon }) => (
        <Link
          key={value}
          href={hrefFor(value)}
          replace
          prefetch={false}
          className={cn(
            "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
  );
}
