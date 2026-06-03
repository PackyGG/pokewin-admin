"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RouteTransitionShell } from "@/components/ux";

/**
 * Client-side window state + pending coordination for /ggr.
 *
 * The window switcher (in the PageHero action slot) and the body it
 * controls (KPI strip + breakdown groups + contributor table) sit in two
 * separate regions of the server-rendered tree. They need to share ONE
 * pending flag so that flipping a window both:
 *
 *   1. flips the clicked chip active instantly + spins it (handled in
 *      `ggr-window-switch.tsx`, which consumes this context), and
 *   2. dims the body figures behind a delay-gated overlay spinner so the
 *      switch never "looks stuck" while the server re-renders the new
 *      window's numbers.
 *
 * The mechanism is the SAME `useTransition` + `router.replace` pattern the
 * dashboard period selector uses (`dashboard-period-selector.tsx`) — the
 * transition keeps the prior render mounted (no blank flash) while the new
 * window streams in. Here it is lifted into context so the switch (the
 * trigger) and the body (the pending-treated region) can both read it.
 *
 * Active-timeframe-only: a window change is a single `?window=` navigation,
 * so the server re-runs `getGgrPageData(window)` for the NEW window only —
 * no eager preload of the other windows. `router.replace` (not push) keeps
 * the back button clean.
 */

type GgrWindowContextValue = {
  /** The active window value as read from the URL (default sentinel handled by caller). */
  current: string;
  /** True while a window-change navigation is in flight. */
  isPending: boolean;
  /**
   * Navigate to `next` window. `defaultWindow` carries no `?window=` param
   * (so a bare `/ggr` deep-link lands on it); every other value sets it.
   */
  navigate: (next: string) => void;
  /** The window value that should NOT carry a `?window=` query param. */
  defaultWindow: string;
};

const GgrWindowContext = React.createContext<GgrWindowContextValue | null>(null);

/**
 * Read the shared GGR window context. Throws if used outside the provider
 * so a mis-wired consumer fails loudly in development rather than silently
 * losing the pending treatment.
 */
export function useGgrWindow(): GgrWindowContextValue {
  const ctx = React.useContext(GgrWindowContext);
  if (!ctx) {
    throw new Error("useGgrWindow must be used within <GgrWindowProvider>");
  }
  return ctx;
}

export function GgrWindowProvider({
  defaultWindow,
  children,
}: {
  /** The window value carried with no `?window=` param (the page default). */
  defaultWindow: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();

  const current = searchParams.get("window") ?? defaultWindow;

  const navigate = React.useCallback(
    (next: string) => {
      if (next === current) return;
      const params = new URLSearchParams(searchParams.toString());
      if (next === defaultWindow) {
        params.delete("window");
      } else {
        params.set("window", next);
      }
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `/ggr?${qs}` : "/ggr", { scroll: false });
      });
    },
    [current, defaultWindow, router, searchParams],
  );

  const value = React.useMemo<GgrWindowContextValue>(
    () => ({ current, isPending, navigate, defaultWindow }),
    [current, isPending, navigate, defaultWindow],
  );

  return (
    <GgrWindowContext.Provider value={value}>
      {children}
    </GgrWindowContext.Provider>
  );
}

/**
 * Wraps the GGR body (the server-rendered KPI strip + breakdown groups +
 * contributor table, passed as `children`) and applies the shared pending
 * treatment: the region dims to ~60% and, once the wait passes the spinner
 * delay, a small non-blocking overlay spinner appears. Built on the ux
 * `RouteTransitionShell`, so it is reduced-motion safe and never blocks
 * pointer/scroll on the stale figures while the new window resolves.
 */
export function GgrBodyPending({ children }: { children: React.ReactNode }) {
  const { isPending } = useGgrWindow();
  return <RouteTransitionShell pending={isPending}>{children}</RouteTransitionShell>;
}
