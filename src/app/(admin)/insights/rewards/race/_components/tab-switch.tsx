"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Sparkles,
  ListOrdered,
  CalendarClock,
  Crosshair,
  Repeat,
  Users,
  Trophy,
  Target,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * URL-driven tab switcher for /insights/rewards/race.
 *
 * Nine tabs covering the full race deep-stats spec:
 *
 *   1. Overview            — total prize, distinct races/winners, daily chart
 *   2. Race-by-race        — list with race_id, type, pool, top winner
 *   3. Per type            — daily / weekly / monthly slice with budget
 *   4. Positions           — winner-position distribution
 *   5. Repeat winners      — multi-race winners + frequency buckets
 *   6. Cohort + Geo        — country / source / signup-recency
 *   7. Top winners         — top 25 period + lifetime
 *   8. Budget              — % of allocated prize budget actually paid
 *   9. ROI                 — race-prize cost vs subsequent gameplay GGR
 *
 * Active tab lives in `?tab=`. Period param survives every switch.
 * Empty `?tab` lands on Overview so a bare URL is shareable.
 */

const TABS = [
  { value: "overview", label: "Overview", Icon: Sparkles },
  { value: "breakdown", label: "Race-by-race", Icon: ListOrdered },
  { value: "per-type", label: "Per type", Icon: CalendarClock },
  { value: "positions", label: "Positions", Icon: Crosshair },
  { value: "repeat", label: "Repeat winners", Icon: Repeat },
  { value: "cohort", label: "Cohort & Geo", Icon: Users },
  { value: "top", label: "Top winners", Icon: Trophy },
  { value: "budget", label: "Budget", Icon: Target },
  { value: "roi", label: "ROI", Icon: TrendingUp },
] as const;

export type RaceInsightsTab = (typeof TABS)[number]["value"];

export function RaceInsightsTabSwitch() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const valueSet = TABS.map((t) => t.value) as string[];
  const current: RaceInsightsTab = valueSet.includes(raw ?? "")
    ? (raw as RaceInsightsTab)
    : "overview";

  function hrefFor(tab: RaceInsightsTab): string {
    const p = new URLSearchParams(searchParams.toString());
    if (tab === "overview") p.delete("tab");
    else p.set("tab", tab);
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div
      role="tablist"
      aria-label="Race insights view"
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/30 p-0.5",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
        "lg:[mask-image:none]",
      )}
    >
      {TABS.map(({ value, label, Icon }) => {
        const active = current === value;
        return (
          <Link
            key={value}
            href={hrefFor(value)}
            role="tab"
            aria-selected={active}
            replace
            scroll={false}
            prefetch={false}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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
