import {
  BadgeCheck,
  Ban,
  CalendarClock,
  CircleDashed,
  Clock3,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";

import { VipPerksResetButton } from "./vip-perks-reset-button";

export type VipPerksStatus =
  | "pending"
  | "active"
  | "expired"
  | "recurring_due"
  | "inactive";

export type VipPerksRosterView = {
  status: VipPerksStatus;
  currentWagerUsd: number;
  requirementWagerUsd: number;
  progressPct: number;
  windowStartedAt: string | null;
  windowEndsAt: string | null;
  unlockedAt: string | null;
};

const STATUS_STYLE: Record<
  VipPerksStatus,
  {
    label: string;
    icon: typeof BadgeCheck;
    className: string;
    barClassName: string;
  }
> = {
  pending: {
    label: "Pending · qualifying",
    icon: CircleDashed,
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    barClassName: "bg-amber-500",
  },
  active: {
    label: "Perks active",
    icon: BadgeCheck,
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    barClassName: "bg-emerald-500",
  },
  expired: {
    label: "Expired",
    icon: TriangleAlert,
    className:
      "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    barClassName: "bg-rose-500",
  },
  recurring_due: {
    label: "Paused · recurring due",
    icon: Clock3,
    className:
      "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    barClassName: "bg-cyan-500",
  },
  inactive: {
    label: "Inactive",
    icon: Ban,
    className: "border-border bg-muted text-muted-foreground",
    barClassName: "bg-muted-foreground/40",
  },
};

export function VipPerksCell({
  perks,
  userId,
  playerLabel,
}: {
  perks: VipPerksRosterView | null;
  userId: string;
  playerLabel: string;
}) {
  if (!perks) {
    return <span className="text-xs text-muted-foreground">Not linked</span>;
  }

  const style = STATUS_STYLE[perks.status];
  const Icon = style.icon;
  const progress = Math.max(0, Math.min(100, perks.progressPct));
  const showProgress = perks.status !== "inactive";

  return (
    <div className="min-w-56 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
            style.className,
          )}
        >
          <Icon className="size-3" aria-hidden />
          {style.label}
        </span>
        {perks.status === "expired" && (
          <VipPerksResetButton userId={userId} playerLabel={playerLabel} />
        )}
      </div>

      {showProgress && (
        <div className="space-y-1">
          <div className="flex justify-between gap-3 text-[11px] tabular-nums">
            <span className="font-medium">
              {formatCurrency(perks.currentWagerUsd)}
            </span>
            <span className="text-muted-foreground">
              of {formatCurrency(perks.requirementWagerUsd)}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={"Weighted wager progress for " + playerLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <div
              className={cn("h-full rounded-full", style.barClassName)}
              style={{ width: String(progress) + "%" }}
            />
          </div>
          <p className="text-[10px] tabular-nums text-muted-foreground">
            {Math.round(progress)}% of weighted-wager requirement
          </p>
        </div>
      )}

      <WindowDate perks={perks} />
    </div>
  );
}

function WindowDate({ perks }: { perks: VipPerksRosterView }) {
  if (perks.status === "inactive") {
    return (
      <p className="text-[11px] text-muted-foreground">
        Perks are disabled globally.
      </p>
    );
  }
  if (perks.status === "active" && !perks.windowEndsAt && perks.unlockedAt) {
    return (
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <BadgeCheck className="size-3" aria-hidden />
        Unlocked {formatDateTime(perks.unlockedAt)}
      </p>
    );
  }
  if (!perks.windowEndsAt) return null;
  return (
    <div className="flex items-start gap-1 text-[11px] text-muted-foreground">
      <CalendarClock className="mt-0.5 size-3 shrink-0" aria-hidden />
      <p>
        {perks.windowStartedAt && (
          <>
            Started {formatDateTime(perks.windowStartedAt)}
            <br />
          </>
        )}
        {perks.status === "expired" ? "Ended" : "Ends"}{" "}
        {formatDateTime(perks.windowEndsAt)}
      </p>
    </div>
  );
}
