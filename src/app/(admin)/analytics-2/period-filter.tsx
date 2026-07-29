"use client";

import { PeriodChips } from "@/components/ux";
import {
  DEFAULT_ANALYTICS_2_PERIOD,
  type Analytics2Period,
} from "./types";

const PERIOD_ITEMS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

export function Analytics2PeriodFilter({
  period,
}: {
  period: Analytics2Period;
}) {
  return (
    <PeriodChips
      items={PERIOD_ITEMS}
      current={period}
      paramKey="period"
      defaultValue={DEFAULT_ANALYTICS_2_PERIOD}
      ariaNoun="period"
    />
  );
}
