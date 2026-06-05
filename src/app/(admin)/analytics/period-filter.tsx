"use client";

import { useSearchParams } from "next/navigation";
import { PeriodChips } from "@/components/ux";

const PERIODS = [
  { label: "Today", value: "today" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
] as const;

const DEFAULT_PERIOD = "30d";

/**
 * Analytics period selector. Thin wrapper over the shared `PeriodChips`
 * primitive (src/components/ux/period-chips.tsx) — the same URL-driven,
 * useTransition-backed chip pattern used across the admin. Swapped from a
 * bespoke `<Link>` row to the primitive so the pending state (dim others +
 * in-chip spinner), the reduced-motion-safe colour transition, and the
 * scroll-preserving `{ scroll: false }` navigation are all consistent.
 *
 * Behaviour is unchanged: same 5 chips, same values, `30d` stays the default
 * (selecting it produces a clean `?`-less URL).
 */
export function PeriodFilter() {
  const searchParams = useSearchParams();
  const current = searchParams.get("period") ?? DEFAULT_PERIOD;

  return (
    <PeriodChips
      items={PERIODS}
      current={current}
      paramKey="period"
      defaultValue={DEFAULT_PERIOD}
      ariaNoun="period"
    />
  );
}
