"use client";

import * as React from "react";
import {
  Bell,
  BellRing,
  ChevronRight,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/utils/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  railSlotStyle,
  useRailWidget,
} from "@/components/right-rail-context";
import type { CreatorAlertsResult } from "../alerts/_queries/creator-alerts";
import { AlertsList } from "../alerts/_components/alerts-list";
import { fetchDockedAlerts } from "./docked-alerts-actions";

/**
 * Persistent docked Alerts widget on the right edge of the Creator Hub shell.
 */

const PANEL_WIDTH_PX = 320;
const REFRESH_INTERVAL_MS = 60_000;

export function DockedAlerts() {
  const { open, setOpen, allOpen, mounted } = useRailWidget("alerts");
  const [data, setData] = React.useState<CreatorAlertsResult | null>(null);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchDockedAlerts();
      setData(result);
    } catch {
      setData({
        alerts: [],
        counts: {
          total: 0,
          unread: 0,
          critical: 0,
          byType: {
            deal_expiring: 0,
            withdraw_cap_near: 0,
            leaderboard_ending: 0,
            risk_flagged: 0,
            pnl_red: 0,
            big_ftd: 0,
            went_live: 0,
          },
        },
        syncError: true,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  const hasUnread = (data?.counts.unread ?? 0) > 0;
  const hasCritical = (data?.counts.critical ?? 0) > 0;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open alerts panel"
        title="Alerts — needs attention"
        style={railSlotStyle("alerts", allOpen, mounted)}
        className={cn(
          "fixed right-0 z-30 flex flex-col items-center justify-center gap-2 rounded-l-lg border border-r-0 bg-card/95 px-2 shadow-md backdrop-blur",
          "hover:bg-card transition-colors",
        )}
      >
        <Bell
          className={cn(
            "size-4",
            hasCritical
              ? "text-rose-500"
              : hasUnread
                ? "text-pink-500"
                : "text-muted-foreground",
          )}
        />
        {(hasUnread || hasCritical) && (
          <span className="relative flex size-1.5">
            <span
              className={cn(
                "absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:hidden",
                hasCritical ? "bg-rose-500" : "bg-pink-500",
              )}
            />
            <span
              className={cn(
                "relative inline-flex size-1.5 rounded-full",
                hasCritical ? "bg-rose-500" : "bg-pink-500",
              )}
            />
          </span>
        )}
        <span
          className="font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Alerts
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Creator Hub alerts"
      style={{ width: PANEL_WIDTH_PX, ...railSlotStyle("alerts", allOpen, mounted) }}
      className={cn(
        "fixed right-0 z-30 flex flex-col overflow-hidden rounded-l-2xl border border-r-0 bg-card/95 shadow-xl backdrop-blur",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Minimize alerts panel"
        title="Minimize"
        className="flex w-full items-center justify-between gap-2 border-b bg-gradient-to-r from-pink-500/5 via-card to-rose-500/5 px-3 py-2 text-left transition-colors hover:from-pink-500/10 hover:to-rose-500/10"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-pink-500/10">
            <Bell className="size-3.5 text-pink-500" />
          </div>
          <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Alerts
          </h3>
          {hasUnread && (
            <span className="inline-flex items-center gap-1 rounded-full border border-pink-500/30 bg-pink-500/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-pink-600 dark:text-pink-400">
              <span className="relative flex size-1">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-pink-500 opacity-75 motion-reduce:hidden" />
                <span className="relative inline-flex size-1 rounded-full bg-pink-500" />
              </span>
              {data?.counts.unread ?? "—"}
            </span>
          )}
        </div>
        <span
          aria-hidden
          className="pointer-events-none rounded-md p-1 text-muted-foreground"
        >
          <ChevronRight className="size-3.5" />
        </span>
      </button>

      <div className="grid grid-cols-3 gap-1 border-b px-3 py-2 text-xs">
        <CountCell
          icon={BellRing}
          label="Active"
          value={data?.counts.total ?? null}
          loading={loading && !data}
        />
        <CountCell
          icon={Bell}
          label="Unread"
          value={data?.counts.unread ?? null}
          loading={loading && !data}
          accent="pink"
        />
        <CountCell
          icon={ShieldAlert}
          label="Critical"
          value={data?.counts.critical ?? null}
          loading={loading && !data}
          accent="rose"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && !data ? (
          <AlertsSkeleton />
        ) : data ? (
          <AlertsList
            alerts={data.alerts}
            syncError={data.syncError}
            onMutate={() => {
              // Re-fetch ONLY the docked panel's own data via the server
              // action — no `router.refresh()`. A full-route refresh here
              // re-renders the whole hub page under the panel and dumps the
              // user's scroll position (the scroll-jump bug). `load()` pulls
              // fresh counts + alerts into this widget's local state, and
              // `AlertsList` already applied the optimistic change, so the
              // panel stays correct without touching the page below.
              void load();
            }}
            compact
          />
        ) : null}
      </div>
    </aside>
  );
}

function CountCell({
  icon: Icon,
  label,
  value,
  loading,
  accent = "muted",
}: {
  icon: LucideIcon;
  label: string;
  value: number | null;
  loading?: boolean;
  accent?: "muted" | "pink" | "rose";
}) {
  const iconClass =
    accent === "pink"
      ? "text-pink-500"
      : accent === "rose"
        ? "text-rose-500"
        : "text-muted-foreground";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1">
        <Icon className={cn("size-3 shrink-0", iconClass)} />
        <span className="truncate text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      {loading || value == null ? (
        <Skeleton className="h-4 w-8" />
      ) : (
        <span className="font-mono text-sm font-bold tabular-nums">
          {formatNumber(value)}
        </span>
      )}
    </div>
  );
}

function AlertsSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}
