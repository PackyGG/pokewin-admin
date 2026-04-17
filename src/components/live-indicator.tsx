"use client";

import * as React from "react";
import Link from "next/link";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/utils/format";
import { fetchLiveUserCount } from "@/lib/actions/live-users";
import type { LiveUserCount } from "@/lib/queries/dashboard-live";

const POLL_INTERVAL_MS = 15_000;

const EMPTY: LiveUserCount = {
  liveNow: 0,
  last5m: 0,
  last60m: 0,
  todayTotal: 0,
};

/**
 * Global "live users" indicator for the admin top bar.
 *
 * Shows a pulsing emerald dot + a count of users with activity in the
 * last 5 minutes (the headline number admins care about — "who's on the
 * site right now"). Tooltip breaks the count down by window so you can
 * tell the difference between a quiet minute and a dying site.
 *
 * Polling:
 *  - 15s interval, matches AutoRefresh cadence on /dashboard
 *  - Pauses when the tab is hidden (same pattern as RecentActivity feed)
 *
 * Click-through lands on /dashboard#live so operators can jump straight
 * to the full live-activity feed.
 */
export function LiveIndicator() {
  const [data, setData] = React.useState<LiveUserCount>(EMPTY);
  // Track whether we've completed the first fetch — avoids the "0 online"
  // flash on initial mount before the server has responded.
  const [hasLoaded, setHasLoaded] = React.useState(false);

  React.useEffect(() => {
    let alive = true;

    const tick = async () => {
      if (!alive) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      try {
        const fresh = await fetchLiveUserCount();
        if (!alive) return;
        setData(fresh);
        setHasLoaded(true);
      } catch {
        // Silent — the header shouldn't blow up if the poll fails.
      }
    };

    // Initial fetch, then poll. We also re-fetch when the tab regains
    // focus so the number is fresh the moment an admin switches back.
    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const headline = data.last5m;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href="/dashboard#live"
            aria-label="Live users online"
            title="Live users online"
            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400"
          />
        }
      >
        {/* Dot: absolute-positioned animate-ping layer + a solid core. The
            ping layer is hidden under prefers-reduced-motion so the dot
            stays static for accessibility. Matches the visual vocabulary
            of RecentActivityLivePulse (blue there, emerald here because
            "online" reads green industry-wide). */}
        <span className="relative flex size-2">
          <span
            aria-hidden
            className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75 motion-reduce:hidden"
          />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        <span className="tabular-nums">
          {hasLoaded ? formatNumber(headline) : "—"}
        </span>
        <span className="hidden sm:inline text-[10px] font-medium uppercase tracking-wider text-emerald-600/80 dark:text-emerald-400/80">
          online
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <div className="flex flex-col gap-0.5 text-left">
          <span className="font-semibold">Live users</span>
          <span>
            {formatNumber(data.liveNow)} in last min
          </span>
          <span>
            {formatNumber(data.last5m)} in last 5 min
          </span>
          <span>
            {formatNumber(data.last60m)} in last hour
          </span>
          <span>
            {formatNumber(data.todayTotal)} today
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
