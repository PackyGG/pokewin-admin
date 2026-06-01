"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Bot as BotIcon,
  Crown,
  Eye,
  Loader2,
  Package as PackageIcon,
  Swords,
  Users as UsersIcon,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatDateTime } from "@/lib/utils/format";
import type { BattleDrilldownData } from "@/lib/queries/insights-games/battle-drilldown";
import { fetchBattleDrilldown } from "./drilldown-actions";

/**
 * Per-battle drilldown popover — same lazy-load pattern as the pack
 * popover. Surfaces participants (with winner highlight), packs, and
 * the canonical full-detail link.
 *
 * House-POV coloring on participant P&L: positive P&L = house gained
 * = emerald; negative = house lost = rose. Winner team gets a crown
 * badge.
 */
export function BattleDrilldownPopover({
  battleId,
  createdAt,
}: {
  battleId: string;
  createdAt: string;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: BattleDrilldownData | null;
    error: string | null;
  }>({ open: false, data: null, error: null });
  const [isPending, startTransition] = useTransition();

  const onOpenChange = (open: boolean) => {
    if (!open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    if (state.data || state.error) {
      setState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const data = await fetchBattleDrilldown(battleId);
        if (!data) {
          setState({
            open: true,
            data: null,
            error: "Battle not found",
          });
          return;
        }
        setState({ open: true, data, error: null });
      } catch (err) {
        setState({
          open: true,
          data: null,
          error:
            err instanceof Error ? err.message : "Failed to load drilldown",
        });
      }
    });
  };

  return (
    <Popover open={state.open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show battle drilldown"
            title="Show battle drilldown"
            className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
          />
        }
      >
        {isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Eye className="size-3" />
        )}
        Preview
        <span className="text-[10px] font-normal text-muted-foreground">
          {formatDateTime(createdAt)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[440px] max-w-[calc(100vw-2rem)] space-y-3 p-3"
      >
        <div className="flex items-start gap-2">
          <Swords className="mt-0.5 size-3.5 shrink-0 text-cyan-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Battle drilldown
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              Participants, pot, packs, winner team
            </p>
          </div>
        </div>

        {state.error ? (
          <p className="px-1 py-2 text-[11px] text-rose-400">{state.error}</p>
        ) : !state.data ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            Loading drilldown…
          </p>
        ) : (
          <DrilldownBody data={state.data} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function DrilldownBody({ data }: { data: BattleDrilldownData }) {
  return (
    <div className="space-y-3">
      {/* Headline strip */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-2 text-[11px] sm:grid-cols-4">
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Mode · Status
          </p>
          <p className="font-semibold capitalize">
            {data.mode} · {data.status}
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Pot
          </p>
          <p className="font-semibold tabular-nums">
            {formatCompactUsd(data.totalPot)}
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Payout
          </p>
          <p className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCompactUsd(data.totalPayout)}
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            House P&L
          </p>
          <p
            className={cn(
              "font-semibold tabular-nums",
              data.housePnl >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {formatCompactUsd(data.housePnl)}
          </p>
        </div>
      </div>

      {(data.borrowPercentage > 0 || data.sponsorshipPercentage > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          {data.borrowPercentage > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-600 dark:text-amber-400">
              {data.borrowPercentage}% borrow
            </span>
          )}
          {data.sponsorshipPercentage > 0 && (
            <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-semibold text-purple-600 dark:text-purple-400">
              {data.sponsorshipPercentage}% sponsored
            </span>
          )}
        </div>
      )}

      {/* Packs */}
      {data.packs.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <PackageIcon className="mr-1 inline size-3" />
            Packs ({data.packs.length})
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {data.packs.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-1.5 rounded-md border bg-card px-1.5 py-1 text-[10px]"
              >
                {p.imageUrl ? (
                  <Image
                    src={p.imageUrl}
                    alt={p.name}
                    width={20}
                    height={20}
                    className="size-5 rounded object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="size-5 rounded bg-muted" />
                )}
                <span className="truncate max-w-[140px]">{p.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatCompactUsd(p.price)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Participants */}
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          <UsersIcon className="mr-1 inline size-3" />
          Participants ({data.participants.length})
        </p>
        <ul className="space-y-0.5">
          {data.participants.map((p) => {
            const label = p.username ?? "—";
            return (
              <li
                key={p.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded border border-border/40 px-1.5 py-1 text-[11px]",
                  p.isWinner && "border-amber-500/30 bg-amber-500/5",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {p.isWinner && (
                    <Crown className="size-3 shrink-0 text-amber-500" />
                  )}
                  {p.image ? (
                    <Image
                      src={p.image}
                      alt={label}
                      width={20}
                      height={20}
                      className="size-5 shrink-0 rounded-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
                      {p.isBot && (
                        <BotIcon className="size-3 text-muted-foreground" />
                      )}
                    </div>
                  )}
                  {p.isBot ? (
                    <span className="truncate font-medium text-muted-foreground">
                      {label} (bot)
                    </span>
                  ) : p.userId ? (
                    <Link
                      href={`/users/${p.userId}`}
                      className="truncate font-medium hover:underline"
                    >
                      {label}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">{label}</span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    T{p.teamNumber}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                  <span className="text-rose-600 dark:text-rose-400">
                    {formatCompactUsd(p.payout)}
                  </span>
                  <span
                    className={cn(
                      "min-w-[56px] text-right font-semibold",
                      p.pnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {formatCompactUsd(p.pnl)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Deep-link to full battle detail */}
      <div className="border-t pt-2">
        <Link
          href={`/battles/${data.battleId}`}
          className="text-[11px] font-medium text-primary hover:underline"
        >
          Open full battle detail →
        </Link>
      </div>
    </div>
  );
}
