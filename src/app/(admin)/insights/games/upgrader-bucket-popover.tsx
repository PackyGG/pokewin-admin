"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { Eye, Loader2, Users } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonAvatar } from "@/components/ux";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import type { UpgraderBucketTopUser } from "@/lib/queries/insights-games/upgrader-drilldown";
import { fetchUpgraderBucketTopUsers } from "./drilldown-actions";

/**
 * Per-bucket top-users popover for the Upgrader tab. Clicking the
 * trigger on any bucket row lazy-loads the top 10 users in that
 * bucket (by total wager) for the active period.
 *
 * Same lazy-load + Popover chrome as the pack / battle drilldowns;
 * one bucket row → one popover, scoped to the bucket key.
 */
export function UpgraderBucketPopover({
  bucket,
  period,
  cohort,
}: {
  bucket: string;
  period: string;
  cohort: string;
}) {
  const [state, setState] = useState<{
    open: boolean;
    rows: UpgraderBucketTopUser[] | null;
    error: string | null;
  }>({ open: false, rows: null, error: null });
  const [isPending, startTransition] = useTransition();

  const onOpenChange = (open: boolean) => {
    if (!open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    if (state.rows || state.error) {
      setState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const rows = await fetchUpgraderBucketTopUsers(period, bucket);
        setState({ open: true, rows, error: null });
      } catch (err) {
        setState({
          open: true,
          rows: null,
          error:
            err instanceof Error ? err.message : "Failed to load top users",
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
            aria-label={`Show top users for ${bucket} bucket`}
            title={`Show top users for ${bucket} bucket`}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
          />
        }
      >
        {isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Eye className="size-3.5" />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[400px] max-w-[calc(100vw-2rem)] space-y-2.5 p-3"
      >
        <div className="flex items-start gap-2">
          <Users className="mt-0.5 size-3.5 shrink-0 text-cyan-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Top users · {bucket}
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              {cohort} · by total wager
            </p>
          </div>
        </div>

        {state.error ? (
          <p className="px-1 py-2 text-[11px] text-rose-400">{state.error}</p>
        ) : !state.rows ? (
          // Skeleton rows match the avatar + name/handle list below so the
          // popover body reads as "users are loading" and doesn't jump.
          <div className="space-y-0.5" role="status" aria-busy="true">
            <span className="sr-only">Loading top users…</span>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-2 px-1 py-1">
                <SkeletonAvatar size="xs" withLabel />
                <Skeleton className="h-3 w-12 shrink-0 rounded" />
              </div>
            ))}
          </div>
        ) : state.rows.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/60">
            No users in this bucket for the period.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {state.rows.map((u, idx) => (
              <li key={u.userId}>
                <Link
                  href={`/users/${u.userId}`}
                  className="flex items-center justify-between gap-2 rounded px-1 py-1 transition-colors hover:bg-muted/60"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground/60 tabular-nums">
                      {idx + 1}.
                    </span>
                    {u.image ? (
                      <Image
                        src={u.image}
                        alt={u.username ?? "user"}
                        width={20}
                        height={20}
                        className="size-5 shrink-0 rounded-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="size-5 shrink-0 rounded-full bg-muted" />
                    )}
                    <span className="truncate text-[11px] font-medium">
                      {u.username ?? "—"}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
                      · {formatNumber(u.bets)} bets
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {formatCompactUsd(u.wager)}
                    </span>
                    <span
                      className={cn(
                        "min-w-[56px] text-right font-semibold",
                        u.pnl >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {formatCompactUsd(u.pnl)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
