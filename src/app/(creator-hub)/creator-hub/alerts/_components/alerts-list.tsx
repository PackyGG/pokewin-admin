"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BellOff,
  Check,
  CheckCheck,
  HandCoins,
  Radio,
  ShieldAlert,
  TrendingDown,
  Trophy,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";

import {
  dismissAlert,
  markAlertRead,
  markAllAlertsRead,
} from "../actions";
import type {
  CreatorAlertItem,
  CreatorAlertSeverity,
  CreatorAlertType,
} from "../_queries/creator-alerts";

const TYPE_ICON: Record<CreatorAlertType, LucideIcon> = {
  deal_expiring: HandCoins,
  withdraw_cap_near: AlertTriangle,
  leaderboard_ending: Trophy,
  risk_flagged: ShieldAlert,
  pnl_red: TrendingDown,
  big_ftd: UserPlus,
  went_live: Radio,
};

const TYPE_LABEL: Record<CreatorAlertType, string> = {
  deal_expiring: "Deal expiring",
  withdraw_cap_near: "Cap nearly hit",
  leaderboard_ending: "LB ending",
  risk_flagged: "Risk flag",
  pnl_red: "P&L red",
  big_ftd: "Big FTD",
  went_live: "Went live",
};

const SEVERITY_BADGE: Record<CreatorAlertSeverity, string> = {
  critical:
    "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  warning:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  info: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
};

type Filter = "all" | "unread" | "critical";

export function AlertsList({
  alerts,
  syncError,
  onMutate,
  compact = false,
}: {
  alerts: CreatorAlertItem[];
  syncError: boolean;
  onMutate?: () => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const formatDateTime = useFormatDateTime();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [bulkPending, setBulkPending] = React.useState(false);

  const filtered = React.useMemo(() => {
    if (filter === "unread") return alerts.filter((a) => a.isUnread);
    if (filter === "critical")
      return alerts.filter((a) => a.severity === "critical");
    return alerts;
  }, [alerts, filter]);

  async function handleRead(id: string) {
    setPendingId(id);
    const result = await markAlertRead(id);
    setPendingId(null);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    onMutate?.();
    router.refresh();
  }

  async function handleDismiss(id: string) {
    setPendingId(id);
    const result = await dismissAlert(id);
    setPendingId(null);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    onMutate?.();
    router.refresh();
  }

  async function handleMarkAllRead() {
    setBulkPending(true);
    const result = await markAllAlertsRead();
    setBulkPending(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("All alerts marked read");
    onMutate?.();
    router.refresh();
  }

  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      {syncError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground sm:text-sm">
          Alert sync hit a transient issue — counts may be stale. Refresh to retry.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "All"],
            ["unread", "Unread"],
            ["critical", "Critical"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === value
                ? "border-pink-500/40 bg-pink-500/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-accent",
            )}
          >
            {label}
          </button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-8 gap-1.5 text-xs"
          disabled={bulkPending || alerts.every((a) => !a.isUnread)}
          onClick={handleMarkAllRead}
        >
          <CheckCheck className="size-3.5" />
          Mark all read
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title="No alerts"
          description={
            filter === "all"
              ? "Nothing needs attention right now — you're caught up."
              : `No ${filter} alerts in the current set.`
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((alert) => {
            const Icon = TYPE_ICON[alert.alertType];
            const busy = pendingId === alert.id;
            return (
              <div
                key={alert.id}
                className={cn(
                  "flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-start",
                  compact && "rounded-xl p-3",
                  alert.isUnread && "border-pink-500/25 bg-pink-500/[0.03]",
                )}
              >
                <div
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-xl",
                    alert.severity === "critical"
                      ? "bg-rose-500/15 text-rose-500"
                      : alert.severity === "warning"
                        ? "bg-amber-500/15 text-amber-500"
                        : "bg-blue-500/15 text-blue-500",
                  )}
                >
                  <Icon className="size-5" />
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      {alert.metadata.title}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn("h-5 text-[10px]", SEVERITY_BADGE[alert.severity])}
                    >
                      {alert.severity}
                    </Badge>
                    <Badge variant="outline" className="h-5 text-[10px]">
                      {TYPE_LABEL[alert.alertType]}
                    </Badge>
                    {alert.isUnread && (
                      <span className="size-2 rounded-full bg-pink-500" title="Unread" />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {alert.metadata.description}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {alert.targetUserId && (
                      <Link
                        href={`/creator-hub/creators/${alert.targetUserId}`}
                        className="font-medium text-blue-500 hover:underline"
                      >
                        {alert.targetUsername ?? alert.targetUserId.slice(0, 8)}
                      </Link>
                    )}
                    {alert.metadata.link && alert.metadata.link !== `/creator-hub/creators/${alert.targetUserId}` && (
                      <Link
                        href={alert.metadata.link}
                        className="text-blue-500 hover:underline"
                      >
                        Open
                      </Link>
                    )}
                    <span title={formatDateTime(alert.createdAt)}>
                      {formatRelative(alert.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5 sm:flex-col sm:items-end">
                  {alert.isUnread && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 text-xs"
                      disabled={busy}
                      onClick={() => handleRead(alert.id)}
                    >
                      <Check className="size-3.5" />
                      Read
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 text-xs text-muted-foreground"
                    disabled={busy}
                    onClick={() => handleDismiss(alert.id)}
                  >
                    <X className="size-3.5" />
                    Dismiss
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
