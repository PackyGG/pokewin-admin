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
 * Period selector for the creator-detail "Code-User GGR trend" band.
 *
 * Writes the active chip into the `period` URL query param; the server
 * page reads it via `searchParams.period`, validates it with
 * `parseDashboardPeriod`, and runs ONLY the windowed Code-User GGR read
 * for that single cutoff (active-timeframe-only — nothing else is
 * pre-computed across windows). The headline Net Creator P&L stays on
 * the LIFETIME window regardless of this chip (lifetime GGR − lifetime
 * cost = a true apples-to-apples net); this selector only drives the
 * windowed GGR trend tile, which is labelled as such.
 *
 * Mirrors the dashboard's `DashboardPeriodSelector`: same chip set, same
 * `router.replace` (not push — the back button doesn't fill up with chip
 * changes), same `useTransition` so the click stays responsive while the
 * server re-render streams in behind a small spinner.
 */
export function NetPnlPeriodSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const currentParam = searchParams.get("period");
  const current: DashboardPeriod =
    currentParam &&
    (DASHBOARD_PERIODS as readonly string[]).includes(currentParam)
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
        <span>GGR window</span>
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
              title={`Show Code-User GGR for ${p}`}
            >
              {active && isPending && (
                <Loader2 className="size-3 animate-spin" />
              )}
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}
