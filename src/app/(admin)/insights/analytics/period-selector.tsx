"use client";

import { useSearchParams } from "next/navigation";
import { PeriodChips } from "@/components/ux";
import { INSIGHTS_PERIODS, type InsightsPeriod } from "./types";

const LABEL_SHORT: Record<InsightsPeriod, string> = {
  "24h": "24h",
  "3d": "3d",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  // Display label kept as "Lifetime" — same human-readable string that
  // shipped originally; only the underlying URL token (`?period=all`)
  // was unified with the dashboard's canonical set.
  all: "Lifetime",
};

const PERIOD_ITEMS = INSIGHTS_PERIODS.map((p) => ({
  value: p,
  label: LABEL_SHORT[p],
}));

/**
 * Period chip strip — global selector at the top of /insights/analytics.
 *
 * Now delegates to the canonical `PeriodChips` (src/components/ux/period-chips.tsx)
 * — the same `useTransition` + `router.replace(..., { scroll: false })`
 * mechanic the dashboard uses. Switching a period keeps the current tab's
 * content MOUNTED (dimmed, with an in-chip spinner) instead of blanking to the
 * skeleton, and preserves every other query param (tab + sub-filters). The
 * page reads `?period=` and renders the matching slice; this component just
 * flips the param.
 */
export function PeriodSelector() {
  const searchParams = useSearchParams();
  const current = (searchParams.get("period") ?? "30d") as InsightsPeriod;
  return (
    <PeriodChips
      items={PERIOD_ITEMS}
      current={current}
      paramKey="period"
      ariaNoun="period"
    />
  );
}
