"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Sparkles,
  Filter,
  Clock,
  Activity,
  Wallet,
  Network,
  Globe2,
  CalendarRange,
  Sun,
  UserMinus,
  Trophy,
  LineChart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LinkPendingShell } from "@/components/ux";

/**
 * URL-driven tab switcher for /insights/rewards/signup. Twelve tabs
 * covering the full deep signup-cohort analytics spec:
 *
 *   1.  Overview        — top KPIs
 *   2.  Funnel          — 5-stage conversion funnel
 *   3.  Time-to-claim   — distribution + percentiles
 *   4.  Retention       — claimer vs non-claimer 24h/7d/30d retention
 *   5.  First deposit   — cohort first-deposit comparison
 *   6.  Source          — auth provider + affiliate code attribution
 *   7.  Country         — top-15 countries
 *   8.  Hour-of-day     — claim timing + day-of-week heatmap
 *   9.  Cohort matrix   — weekly cohort × claim × 30d retention
 *  10.  Drop-off        — 5 mutually-exclusive drop-off cause buckets
 *  11.  Top recipients  — top 25 claimers (lifetime or window)
 *  12.  Geo trend       — top-5 countries' signup → claim trend
 *
 * Active tab lives in `?tab=`. Period param survives every switch.
 * Empty `?tab` lands on Overview. Same `replace + scroll={false}` as
 * the parent insights tab switch so reload + ⌘-click still work.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "funnel", label: "Funnel", Icon: Filter },
  { value: "time-to-claim", label: "Time-to-claim", Icon: Clock },
  { value: "retention", label: "Retention", Icon: Activity },
  { value: "first-deposit", label: "First deposit", Icon: Wallet },
  { value: "source", label: "Source", Icon: Network },
  { value: "country", label: "Country", Icon: Globe2 },
  { value: "hour", label: "Hour-of-day", Icon: Sun },
  { value: "cohort", label: "Cohort matrix", Icon: CalendarRange },
  { value: "drop-off", label: "Drop-off", Icon: UserMinus },
  { value: "top", label: "Top recipients", Icon: Trophy },
  { value: "geo-trend", label: "Geo trend", Icon: LineChart },
] as const;

export type SignupInsightsTab = (typeof TABS)[number]["value"];

export function SignupInsightsTabSwitch() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const current: SignupInsightsTab = (TABS.map((t) => t.value) as string[]).includes(
    raw ?? "",
  )
    ? (raw as SignupInsightsTab)
    : "overview";
  const period = searchParams.get("period");
  const carryPeriod = period ? `period=${encodeURIComponent(period)}` : "";

  return (
    <div
      role="tablist"
      aria-label="Signup insights view"
      className="inline-flex flex-wrap rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        const tabParam = value === "overview" ? "" : `tab=${value}`;
        const params = [tabParam, carryPeriod].filter(Boolean).join("&");
        const href = params
          ? `/insights/rewards/signup?${params}`
          : "/insights/rewards/signup";
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
