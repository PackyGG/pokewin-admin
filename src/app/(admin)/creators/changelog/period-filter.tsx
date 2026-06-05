"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner, transition } from "@/components/ux";
import {
  DASHBOARD_PERIODS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";

/**
 * Period selector for /creators/changelog.
 *
 * Mirrors the visual + interaction model of the global dashboard period
 * selector (`src/app/(admin)/dashboard/dashboard-period-selector.tsx`):
 * chips write the active window into the `?period=` URL query param, the
 * server page reads it via `searchParams.period`, and `useTransition`
 * keeps the click responsive while the server re-renders behind a small
 * spinner inside the active chip. `router.replace` (not push) so the back
 * button doesn't fill up with chip changes.
 *
 * The ONE difference from the dashboard selector is the default window:
 * the changelog defaults to `3h` (a tight recent-activity feed) rather
 * than the dashboard's 24h. The default chip is the no-param state, so
 * selecting it deletes `period` from the URL — keeping the canonical URL
 * for the landing view clean and matching `getCreatorsChangelogEvents`'s
 * own `period = "3h"` fallback so the chips and the data agree on mount.
 */
const CHANGELOG_DEFAULT_PERIOD: DashboardPeriod = "3h";

export function ChangelogPeriodFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentParam = searchParams.get("period");
  const current: DashboardPeriod =
    currentParam &&
    (DASHBOARD_PERIODS as readonly string[]).includes(currentParam)
      ? (currentParam as DashboardPeriod)
      : CHANGELOG_DEFAULT_PERIOD;

  function pick(next: DashboardPeriod) {
    if (next === current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === CHANGELOG_DEFAULT_PERIOD) {
      params.delete("period");
    } else {
      params.set("period", next);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
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
                "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
                transition("colors", "fast"),
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                isPending && !active && "opacity-50",
              )}
              title={`Switch changelog to ${p}`}
            >
              {active && isPending && (
                <Spinner size={12} label={`Loading ${p} changelog`} />
              )}
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}
