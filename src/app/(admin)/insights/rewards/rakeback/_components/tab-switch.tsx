"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Percent,
  Clock,
  Users,
  Layers,
  UserMinus,
  TrendingUp,
  Trophy,
  CalendarRange,
  Globe2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

/**
 * URL-driven tab switcher for /insights/rewards/rakeback. Ten tabs
 * covering the deep rakeback analysis spec:
 *
 *   1. Overview        — top KPI strip + daily volume chart + period delta
 *   2. % of wager      — distribution histogram + avg / median / p95
 *   3. Cadence         — time-between-claims distribution + medians
 *   4. Active subs     — distinct claimants, weekly active, cohort retention
 *   5. Tier spread     — daily / weekly / monthly slice
 *   6. Lapsed          — prior-window claimants who stopped (classified)
 *   7. ROI             — cost vs subsequent gameplay GGR
 *   8. Top claimers    — top 25 (period or lifetime)
 *   9. Daily breakdown — day-by-day table
 *  10. Geo / Source    — country + signup-source breakdown
 *
 * Active tab in `?tab=`. Period + ROI lookback + leaderboard scope
 * params survive every switch.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "rate", label: "% of wager", Icon: Percent },
  { value: "cadence", label: "Cadence", Icon: Clock },
  { value: "active", label: "Active subs", Icon: Users },
  { value: "tiers", label: "Tier spread", Icon: Layers },
  { value: "lapsed", label: "Lapsed", Icon: UserMinus },
  { value: "roi", label: "ROI", Icon: TrendingUp },
  { value: "top", label: "Top claimers", Icon: Trophy },
  { value: "daily", label: "Daily", Icon: CalendarRange },
  { value: "geo", label: "Geo / Source", Icon: Globe2 },
] as const;

export type RakebackTab = (typeof TABS)[number]["value"];

export function RakebackTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current: RakebackTab = (TABS.map((t) => t.value) as string[]).includes(
    raw ?? "",
  )
    ? (raw as RakebackTab)
    : "overview";
  const period = searchParams.get("period");
  const lookback = searchParams.get("lookback");
  const scope = searchParams.get("scope");
  const carry = [
    period ? `period=${encodeURIComponent(period)}` : null,
    lookback ? `lookback=${encodeURIComponent(lookback)}` : null,
    scope ? `scope=${encodeURIComponent(scope)}` : null,
  ]
    .filter(Boolean)
    .join("&");

  return (
    <div
      role="tablist"
      aria-label="Rakeback insights view"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const tabParam = value === "overview" ? "" : `tab=${value}`;
        const params = [tabParam, carry].filter(Boolean).join("&");
        const href = params
          ? `/insights/rewards/rakeback?${params}`
          : "/insights/rewards/rakeback";
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
