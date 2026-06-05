"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { TILE_COLORS } from "@/components/modern-panels";
import type { AccentColor } from "../_forecast-engine";

/**
 * Hub controls — the reward picker + the period filter.
 *
 * Both are plain `<Link replace>` navigations that preserve the OTHER param, so
 * switching reward keeps the period and vice-versa. `prefetch={false}` so a
 * hover does not eagerly fetch a different reward's baseline (active-timeframe-
 * only). Switching either param swaps the page's `<Suspense key>` and lazily
 * loads only the now-selected reward + period.
 */

const PERIODS = [
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

type RewardOption = {
  key: string;
  label: string;
  accent: AccentColor;
};

export function ForecastRewardPicker({
  rewards,
  active,
}: {
  rewards: RewardOption[];
  active: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = searchParams.get("period");
  const carryPeriod = period ? `&period=${encodeURIComponent(period)}` : "";

  return (
    <div className="flex flex-wrap gap-1.5">
      {rewards.map((r) => {
        const isActive = r.key === active;
        const colors = TILE_COLORS[r.accent];
        return (
          <Link
            key={r.key}
            href={`${pathname}?reward=${r.key}${carryPeriod}`}
            replace
            prefetch={false}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? cn(colors.bg, colors.text)
                : "border-border/60 text-muted-foreground hover:text-foreground",
            )}
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}

export function ForecastPeriodFilter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? "30d";
  const reward = searchParams.get("reward");
  const carryReward = reward ? `&reward=${encodeURIComponent(reward)}` : "";

  return (
    <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {PERIODS.map(({ label, value }) => (
        <Link
          key={value}
          href={`${pathname}?period=${value}${carryReward}`}
          replace
          prefetch={false}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            current === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
