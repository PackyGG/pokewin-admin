"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CircleDollarSign,
  Clock3,
  Hash,
  Loader2,
  RefreshCw,
  Trophy,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber, formatRelative } from "@/lib/utils/format";
import type { ActiveEosBattle } from "@/lib/queries/eos-active-preview";

const MODE_LABELS: Record<string, string> = {
  normal: "Normal",
  jackpot: "Jackpot",
  group: "Group",
  hp_rush: "HP Rush",
  lowest: "Lowest",
};

function signedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value))}`;
}

function stakeLabel(battle: ActiveEosBattle): string {
  return battle.currency === "coin"
    ? `${formatNumber(battle.stakeAmount)} coins`
    : formatCurrency(battle.stakeAmount);
}

export function LiveBattleRows({ battles }: { battles: ActiveEosBattle[] }) {
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      startRefresh(() => router.refresh());
    };
    const timer = window.setInterval(refresh, 2_500);
    return () => window.clearInterval(timer);
  }, [router]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Updates every 2.5 seconds. Results appear as soon as the EOS-backed
          settlement commits, before the player animation finishes.
        </p>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {isRefreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          Live
        </span>
      </div>

      {battles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-muted-foreground">
          <Clock3 className="size-6" />
          <span className="text-sm">No active battles right now.</span>
        </div>
      ) : (
        battles.map((battle) => <ActiveBattleCard key={battle.id} battle={battle} />)
      )}
    </div>
  );
}

function ActiveBattleCard({ battle }: { battle: ActiveEosBattle }) {
  const ready = battle.status === "outcome_ready";

  return (
    <article className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px] uppercase">
          {MODE_LABELS[battle.mode] ?? battle.mode}
        </Badge>
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] uppercase",
            ready
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          {ready
            ? "Outcome ready"
            : battle.status === "waiting"
              ? "Waiting for players"
              : "Waiting for EOS block"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {battle.teams}×{battle.playersPerTeam} · {battle.participantCount} joined
        </span>
        <span className="text-xs font-semibold tabular-nums">
          {battle.currency === "coin"
            ? `${formatNumber(battle.betAmount)} coins / seat`
            : `${formatCurrency(battle.betAmount)} / seat`}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {formatRelative(battle.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {battle.creatorUsername ?? "Unknown creator"}
        </span>
        {ready && battle.creatorWon !== null && (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] uppercase",
              battle.creatorWon
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
            )}
          >
            Creator {battle.creatorWon ? "wins" : "loses"}
          </Badge>
        )}
        {ready && battle.netAmount !== null && (
          <span
            className={cn(
              "text-sm font-bold tabular-nums",
              battle.netAmount >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {signedCurrency(battle.netAmount)} net
          </span>
        )}
      </div>

      {ready ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <OutcomeTile
            icon={Trophy}
            label="Creator payout"
            value={
              battle.payoutAmount === null
                ? "—"
                : formatCurrency(battle.payoutAmount)
            }
            detail={
              battle.creatorWon
                ? battle.creatorFillFunded
                  ? `Routes to creator session conversion · team ${battle.winnerTeam} split ${formatCurrency(battle.totalUnpacked ?? 0)} across ${battle.winningTeamSize}`
                  : `Team ${battle.winnerTeam} split ${formatCurrency(battle.totalUnpacked ?? 0)} across ${battle.winningTeamSize}`
                : `Team ${battle.winnerTeam} won`
            }
          />
          <OutcomeTile
            icon={CircleDollarSign}
            label="Creator stake"
            value={stakeLabel(battle)}
            detail={
              battle.creatorFillFunded
                ? "Paid from creator session fill"
                : battle.creatorBorrowPercentage > 0
                ? `${battle.creatorBorrowPercentage}% borrowed`
                : "Paid by creator"
            }
          />
          <OutcomeTile
            icon={CircleDollarSign}
            label="Sponsored seats"
            value={formatCurrency(battle.sponsorshipCost)}
            detail={
              battle.sponsorshipPercentage > 0
                ? `${battle.sponsorshipPercentage}% sponsorship`
                : "No sponsorship"
            }
          />
          <OutcomeTile
            icon={CircleDollarSign}
            label="Creator net"
            value={
              battle.netAmount === null ? "Mixed units" : signedCurrency(battle.netAmount)
            }
            detail={
              battle.netAmount === null
                ? "Coin stake and USD card value"
                : "Payout − stake − sponsored seats"
            }
            valueClassName={
              battle.netAmount === null
                ? undefined
                : battle.netAmount >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
            }
          />
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          The exact winner and payout cannot be known until the battle receives
          its EOS block. This row will update automatically when it does.
        </p>
      )}

      <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <Hash className="size-3 shrink-0" />
        <span className="shrink-0">EOS</span>
        {battle.eosBlockHash ? (
          <code className="min-w-0 truncate" title={battle.eosBlockHash}>
            {battle.eosBlockHash}
          </code>
        ) : (
          <span>not assigned yet</span>
        )}
        <code className="ml-auto shrink-0 text-[10px]" title={battle.id}>
          {battle.id.slice(0, 8)}
        </code>
      </div>
    </article>
  );
}

function OutcomeTile({
  icon: Icon,
  label,
  value,
  detail,
  valueClassName,
}: {
  icon: typeof Trophy;
  label: string;
  value: string;
  detail: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/25 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className={cn("mt-1 text-base font-bold tabular-nums", valueClassName)}>
        {value}
      </p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}
