"use client";

import { cn } from "@/lib/utils";
import { Spinner, transition } from "@/components/ux";
import { useGgrWindow } from "./ggr-window-shell";

/**
 * Window switcher for /ggr — 24h / 3d / 7d / Lifetime.
 *
 * Drives the shared `GgrWindowProvider` (in `ggr-window-shell.tsx`): a
 * click runs a `useTransition` + `router.replace` to the new `?window=`,
 * which the server reads to re-run `getGgrPageData(window)` for the NEW
 * window only (active-timeframe-only — the other windows are never eager
 * loaded). The same pending flag dims the body figures via
 * `GgrBodyPending`, so the switch reads as responsive instead of frozen
 * while the new numbers stream in.
 *
 * The clicked chip flips active immediately and spins (the dashboard
 * period-selector pattern); the other chips dim while pending. Default
 * (`24h`) carries no `?window=` param so a bare `/ggr` deep-link lands on
 * it. "Lifetime" maps to the canonical `all` period value — the server
 * coerces it through `ggrWindowToMetricWindow("all")` to an unbounded
 * (capped, server-side) lookback.
 */

const WINDOWS = [
  { value: "24h", label: "Last 24h" },
  { value: "3d", label: "Last 3 days" },
  { value: "7d", label: "Last 7 days" },
  { value: "all", label: "Lifetime" },
] as const;

export type GgrWindowValue = (typeof WINDOWS)[number]["value"];

export function GgrWindowSwitch() {
  const { current, isPending, navigate } = useGgrWindow();

  return (
    <div
      role="tablist"
      aria-label="GGR window"
      className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {WINDOWS.map(({ value, label }) => {
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            // Disable the active chip (no-op navigation) and every chip
            // while a switch is in flight so a double-click can't queue a
            // second navigation mid-transition.
            disabled={active || isPending}
            onClick={() => navigate(value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
              transition("colors", "fast"),
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              // Dim the non-active chips while pending so the busy state is
              // legible without blanking the strip.
              isPending && !active && "opacity-50",
            )}
            title={`Switch GGR window to ${label}`}
          >
            {active && isPending && (
              <Spinner size={14} label={`Loading ${label} GGR`} />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
