"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, Infinity as InfinityIcon, Timer } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/utils/format";
import type { LeaderboardClaimWindow } from "@/lib/reward-expiry/leaderboard-claim-window";

function formatRemainingMs(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function LiveCountdown({
  targetIso,
  initialMs,
  className,
}: {
  targetIso: string;
  initialMs: number;
  className?: string;
}) {
  const target = new Date(targetIso).getTime();
  const [remaining, setRemaining] = useState(initialMs);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const sync = () => setRemaining(target - Date.now());
    sync();
    const id = setInterval(sync, 30_000);
    return () => clearInterval(id);
  }, [target]);

  return (
    <span className={cn("tabular-nums font-semibold", className)}>
      {formatRemainingMs(remaining)}
    </span>
  );
}

/**
 * Claim-window banner for an affiliate / creator leaderboard — shows whether
 * prizes can still be claimed and how long until the window closes. The window
 * opens once the leaderboard ends and runs for `leaderboard_days`
 * (`reward_expiry_leaderboard_days`); 0 = never expires. Display only —
 * enforcement is claim-time on the game backend.
 *
 * Colors here are urgency semantics (green = time left, red = expired), not
 * house-P&L semantics — mirrors the race claim-expiry banner.
 */
export function LeaderboardClaimExpiryBanner({
  window: w,
  tz,
}: {
  window: LeaderboardClaimWindow;
  tz?: string;
}) {
  const fmt = (iso: string) => formatDateTime(iso, tz);

  if (w.status === "unavailable") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-600 dark:text-amber-400">
        <Clock className="size-4 shrink-0 mt-0.5" />
        <p>
          Prize expiry is unavailable — the reward-expiry API isn&apos;t
          reachable on this backend deploy. Claim windows are configured on{" "}
          <Link href="/security" className="underline underline-offset-2">
            Security
          </Link>
          .
        </p>
      </div>
    );
  }

  const daysLabel =
    w.expiryDays === 0
      ? "never expires"
      : `${w.expiryDays} day${w.expiryDays === 1 ? "" : "s"} after the event ends`;

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        w.status === "expired" && "border-red-500/40 bg-red-500/10",
        w.status === "claimable" && "border-emerald-500/30 bg-emerald-500/5",
        (w.status === "period_active" || w.status === "never_expires") &&
          "border-border bg-muted/15",
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2 min-w-0">
          {w.status === "expired" ? (
            <Timer className="size-4 shrink-0 mt-0.5 text-red-500" />
          ) : w.status === "never_expires" ? (
            <InfinityIcon className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
          ) : (
            <Clock className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
          )}
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-semibold">
              {w.status === "expired"
                ? "Claim window expired"
                : w.status === "claimable"
                  ? "Time left to claim"
                  : w.status === "period_active"
                    ? "Event still running"
                    : "Prize claim window"}
            </p>
            <p className="text-xs text-muted-foreground">
              Leaderboard prizes · {daysLabel}
            </p>
          </div>
        </div>

        <div className="shrink-0 text-right space-y-0.5">
          {w.status === "never_expires" && (
            <p className="text-sm font-medium text-muted-foreground">
              No expiry
            </p>
          )}
          {w.status === "period_active" && w.endIso && (
            <>
              <p className="text-xs text-muted-foreground">Event ends</p>
              {w.msUntilPeriodEnd != null && w.msUntilPeriodEnd > 0 ? (
                <LiveCountdown
                  targetIso={w.endIso}
                  initialMs={w.msUntilPeriodEnd}
                  className="text-sm text-foreground"
                />
              ) : (
                <p className="text-sm tabular-nums">{fmt(w.endIso)}</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Prizes claimable after this
              </p>
            </>
          )}
          {w.status === "claimable" &&
            w.claimExpiresAtIso &&
            w.msUntilClaimExpires != null && (
              <>
                <LiveCountdown
                  targetIso={w.claimExpiresAtIso}
                  initialMs={w.msUntilClaimExpires}
                  className="text-base text-emerald-600 dark:text-emerald-400"
                />
                <p className="text-[11px] text-muted-foreground">
                  until {fmt(w.claimExpiresAtIso)}
                </p>
              </>
            )}
          {w.status === "expired" && w.claimExpiresAtIso && (
            <>
              <p className="text-sm font-medium text-red-600 dark:text-red-400">
                Expired
              </p>
              <p className="text-[11px] text-muted-foreground">
                since {fmt(w.claimExpiresAtIso)}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
