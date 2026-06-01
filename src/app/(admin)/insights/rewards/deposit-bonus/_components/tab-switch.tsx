"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Target,
  Users,
  TrendingUp,
  Globe2,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * URL-driven tab switcher for /insights/rewards/deposit-bonus.
 *
 * Five super-tabs grouping the 14 metric blocks the spec calls for:
 *
 *   1. Overview         — KPI strip + daily volume chart + period delta
 *                          + daily breakdown table
 *   2. Cap & Ratio      — cap analysis (hit rate, distribution, top
 *                          hitters, biggest cap deposits) + bonus/
 *                          deposit ratio histogram
 *   3. Cohorts          — with vs without bonus split, new vs returning,
 *                          repeat-claimant segmentation, time-to-claim
 *                          latency
 *   4. ROI & Geo        — ROI vs subsequent GGR, country breakdown,
 *                          signup-source breakdown, time-of-day pattern
 *   5. Top & Risk       — top 25 bonus recipients + suspicious-claimant
 *                          surveillance (cash-out, no-wager, alts)
 *
 * Active tab lives in `?tab=`. Period param survives every switch.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "cap", label: "Cap & Ratio", Icon: Target },
  { value: "cohorts", label: "Cohorts", Icon: Users },
  { value: "roi", label: "ROI & Geo", Icon: TrendingUp },
  { value: "risk", label: "Top & Risk", Icon: Shield },
] as const;

export type DepositBonusTab = (typeof TABS)[number]["value"];

// Map for the floating compass icon at the right of the tab strip when
// every section has its own glyph — currently unused but kept for
// parity with the cross-category /insights/rewards switch.
void Globe2;

export function DepositBonusTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current: DepositBonusTab = (TABS.map((t) => t.value) as string[]).includes(
    raw ?? "",
  )
    ? (raw as DepositBonusTab)
    : "overview";
  const period = searchParams.get("period");
  const carryPeriod = period ? `period=${encodeURIComponent(period)}` : "";

  return (
    <div
      role="tablist"
      aria-label="Deposit bonus insights view"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const tabParam = value === "overview" ? "" : `tab=${value}`;
        const params = [tabParam, carryPeriod].filter(Boolean).join("&");
        const href = params
          ? `/insights/rewards/deposit-bonus?${params}`
          : "/insights/rewards/deposit-bonus";
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
