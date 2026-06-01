"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Users,
  Percent,
  TrendingUp,
  Filter,
  Clock,
  Crown,
  Globe,
  Network,
  Coins,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { INSIGHTS_TABS, type InsightsTab } from "./types";

const TAB_META: Record<InsightsTab, { label: string; icon: typeof BarChart3 }> = {
  overview: { label: "Overview", icon: BarChart3 },
  cohorts: { label: "Cohorts", icon: Users },
  retention: { label: "Retention", icon: Percent },
  ltv: { label: "LTV", icon: TrendingUp },
  funnel: { label: "Funnel", icon: Filter },
  heatmap: { label: "Heatmap", icon: Clock },
  whales: { label: "Whales", icon: Crown },
  geo: { label: "Geo", icon: Globe },
  sources: { label: "Sources", icon: Network },
  // Money Flow tab — Coins icon matches the "decompose GGR/P&L gap"
  // story (where do all the dollars go?). Sits at the end of the strip
  // so flipping into it doesn't shuffle the existing 9-tab order.
  "money-flow": { label: "Money Flow", icon: Coins },
};

/**
 * Tab strip for /insights/analytics. Same horizontal-scroller + edge-fade
 * pattern as the legacy /analytics tab nav so the two pages stay visually
 * consistent. 9 tabs × ~110px ≈ 990px — fits desktop, scrolls on phones.
 */
export function InsightsTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "overview") as InsightsTab;

  function hrefFor(tab: InsightsTab): string {
    // Preserve period + drop tab-specific sub-params (e.g. ?whalesBy=…
    // shouldn't leak into the geo tab). Keep `period` only — every
    // other URL slice is a tab-local control.
    const p = new URLSearchParams();
    const period = searchParams.get("period");
    if (period) p.set("period", period);
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  return (
    <div
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        // Edge-fade mask hints at off-screen chips on phones; dropped at
        // lg+ where all 9 chips fit.
        "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
        "lg:[mask-image:none]",
      )}
    >
      {INSIGHTS_TABS.map((value) => {
        const { label, icon: Icon } = TAB_META[value];
        return (
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
        );
      })}
    </div>
  );
}
