"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DASHBOARD_PERIODS,
  DEFAULT_DASHBOARD_PERIOD,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";

/**
 * Global period selector for /dashboard.
 *
 * Writes the active chip into the `period` URL query param; the server
 * page reads it via `searchParams.period`, validates it, and runs the
 * heavy aggregate against that single cutoff. The previous behaviour
 * was the opposite: the server computed all 9 windows in one giant
 * query and every card flipped its own internal chip selector to pick
 * which slice to show. Result: a lot of wasted scan work on windows
 * the admin never looked at, and the page auto-refreshed all 9 of them
 * every 60 seconds.
 *
 * Switching to URL-driven state also means the chosen period is
 * preserved across refreshes, deep-linkable, and back-button-friendly.
 *
 * `useTransition` keeps the click responsive — the chip flips active
 * immediately, and the server re-render streams in behind a small
 * spinner inside the active chip. `router.replace` (not push) so the
 * back button doesn't fill up with chip changes.
 */
export function DashboardPeriodSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentParam = searchParams.get("period");
  const current: DashboardPeriod =
    currentParam && (DASHBOARD_PERIODS as readonly string[]).includes(currentParam)
      ? (currentParam as DashboardPeriod)
      : DEFAULT_DASHBOARD_PERIOD;

  function pick(next: DashboardPeriod) {
    if (next === current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_DASHBOARD_PERIOD) {
      params.delete("period");
    } else {
      params.set("period", next);
    }
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Clock className="size-3.5" />
        <span>Period</span>
      </div>
      <div className="flex flex-wrap items-center gap-0.5">
        {DASHBOARD_PERIODS.map((p) => {
          const active = p === current;
          return (
            <button
              key={p}
              type="button"
              onClick={() => pick(p)}
              disabled={active || isPending}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                isPending && !active && "opacity-50",
              )}
              title={`Switch dashboard to ${p}`}
            >
              {active && isPending && <Loader2 className="size-3 animate-spin" />}
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}
