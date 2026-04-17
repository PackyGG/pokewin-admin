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
    <div className="flex gap-1 overflow-x-auto rounded-lg border bg-muted/50 p-1">
      {TABS.map(({ value, label, icon: Icon }) => (
        <Link
          key={value}
          href={hrefFor(value)}
          replace
          prefetch={false}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
