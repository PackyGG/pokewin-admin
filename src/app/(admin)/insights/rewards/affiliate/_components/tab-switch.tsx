"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Trophy,
  Layers,
  Users,
  UserMinus,
  Network,
  Globe2,
  CircleDollarSign,
  RotateCcw,
  Shuffle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

/**
 * URL-driven tab switcher for /insights/rewards/affiliate. Ten tabs
 * covering the full per-affiliate ROI + funnel spec.
 *
 * Active tab in `?tab=`. Period param survives every switch. Empty
 * `?tab` lands on Overview so a bare `/insights/rewards/affiliate`
 * stays shareable.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "top-wager", label: "Top by wager", Icon: Trophy },
  { value: "tier-distribution", label: "Tier distribution", Icon: Layers },
  { value: "cohort", label: "Cohort", Icon: Users },
  { value: "inactive", label: "Inactive", Icon: UserMinus },
  { value: "code-perf", label: "Code funnel", Icon: Network },
  { value: "geo", label: "Geo", Icon: Globe2 },
  { value: "lifetime-roi", label: "Lifetime ROI", Icon: CircleDollarSign },
  { value: "cadence", label: "Claim cadence", Icon: RotateCcw },
  { value: "code-switch", label: "Code-switch", Icon: Shuffle },
] as const;

export type AffiliateInsightsTab = (typeof TABS)[number]["value"];

export function AffiliateInsightsTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current: AffiliateInsightsTab = (TABS.map((t) => t.value) as string[]).includes(
    raw ?? "",
  )
    ? (raw as AffiliateInsightsTab)
    : "overview";
  const period = searchParams.get("period");
  const carryPeriod = period ? `period=${encodeURIComponent(period)}` : "";

  return (
    <div
      role="tablist"
      aria-label="Affiliate insights view"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const tabParam = value === "overview" ? "" : `tab=${value}`;
        const params = [tabParam, carryPeriod].filter(Boolean).join("&");
        const href = params
          ? `/insights/rewards/affiliate?${params}`
          : "/insights/rewards/affiliate";
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
            <LinkPendingShell>
              <Icon className="size-3.5" />
              {label}
            </LinkPendingShell>
          </Link>
        );
      })}
    </div>
  );
}
