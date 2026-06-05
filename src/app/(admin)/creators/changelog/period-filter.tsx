"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner, transition } from "@/components/ux";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import {
  CREATORS_MIN_PERIOD,
  CREATORS_PERIODS,
  clampCreatorsPeriod,
} from "../_lib/search-params";

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
 * Floored to 48h like the main /creators page: this renders only the
 * `CREATORS_PERIODS` chips (48h · 3d · 7d · 30d · all) — the sub-48h
 * windows (1h/3h/6h/12h/24h) are too noisy for a creator-marketing feed,
 * so they're dropped from the rendered set AND any `?period=` below 48h
 * (or an absent param → the global 24h default) is clamped UP to 48h via
 * `clampCreatorsPeriod`. The page parse + this control share that helper
 * (mirroring the main /creators `CreatorsPeriodControl`) so the loaded
 * window and the highlighted chip never disagree. 48h is also the
 * clean-URL sentinel — selecting it drops the param (the page clamps a
 * missing param up to 48h), matching `getCreatorsChangelogEvents`'s own
 * `period = "48h"` fallback so the chips and the data agree on mount.
 */
export function ChangelogPeriodFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // /creators (and this changelog) enforce 48h as the SHORTEST window —
  // clamp any incoming `?period=` below 48h (or absent → the global 24h
  // default) UP to 48h so the active chip is always one that's rendered.
  // Reuses the shared parse/clamp helper so the control and the server
  // page agree on the effective window.
  const current: DashboardPeriod = clampCreatorsPeriod(
    searchParams.get("period"),
  );

  function pick(next: DashboardPeriod) {
    if (next === current) return;
    const params = new URLSearchParams(searchParams.toString());
    // 48h is the /creators minimum AND its clean-URL sentinel — selecting
    // it drops the param (the page clamps a missing param up to 48h), so
    // the canonical changelog URL carries no `?period=`.
    if (next === CREATORS_MIN_PERIOD) {
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
        {CREATORS_PERIODS.map((p) => {
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
              {p === "all" ? "All" : p}
            </button>
          );
        })}
      </div>
    </div>
  );
}
