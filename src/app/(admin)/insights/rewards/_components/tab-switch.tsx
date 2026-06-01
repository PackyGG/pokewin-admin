"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Layers,
  TrendingUp,
  Users,
  Network,
  CalendarRange,
  Trophy,
  Activity,
  Globe2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * URL-driven tab switcher for /insights/rewards. Nine tabs covering the
 * full cross-reward analysis spec:
 *
 *   1. Overview                — total marketing cost, ROI, period delta
 *   2. Per-category deep dive  — every category's deep stats panel
 *   3. ROI analysis            — cost vs subsequent GGR per category
 *   4. Retention lift          — claimants vs non-claimants retention
 *   5. Stacking analysis       — multi-category claimants + LTV
 *   6. Cohort comparison       — signup cohort × usage × LTV
 *   7. Top spenders            — top 25 reward recipients
 *   8. Forecasting             — projected marketing spend per category
 *   9. Geo / Source            — reward distribution by country / source
 *
 * Active tab lives in `?tab=`. Period param survives every switch.
 * Empty `?tab` lands on Overview so a bare `/insights/rewards` is
 * shareable. Same `replace + scroll={false}` pattern as the
 * /rewards/analytics tab switch so reload + ⌘-click still work.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "categories", label: "Categories", Icon: Layers },
  { value: "roi", label: "ROI", Icon: TrendingUp },
  { value: "retention", label: "Retention", Icon: Activity },
  { value: "stacking", label: "Stacking", Icon: Network },
  { value: "cohort", label: "Cohort", Icon: CalendarRange },
  { value: "top", label: "Top spenders", Icon: Trophy },
  { value: "forecast", label: "Forecast", Icon: Users },
  { value: "geo", label: "Geo / Source", Icon: Globe2 },
] as const;

export type InsightsRewardsTab = (typeof TABS)[number]["value"];

export function InsightsRewardsTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current: InsightsRewardsTab = (TABS.map((t) => t.value) as string[]).includes(
    raw ?? "",
  )
    ? (raw as InsightsRewardsTab)
    : "overview";
  const period = searchParams.get("period");
  const carryPeriod = period ? `period=${encodeURIComponent(period)}` : "";

  return (
    <div
      role="tablist"
      aria-label="Rewards insights view"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const tabParam = value === "overview" ? "" : `tab=${value}`;
        const params = [tabParam, carryPeriod].filter(Boolean).join("&");
        const href = params ? `/insights/rewards?${params}` : "/insights/rewards";
        return (
          <Link
            key={value}
            href={href}
            role="tab"
            aria-selected={active}
            replace
            scroll={false}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
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
