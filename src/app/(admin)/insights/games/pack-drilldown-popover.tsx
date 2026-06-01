"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ChevronDown,
  Eye,
  Loader2,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import type { PackDrilldownData } from "@/lib/queries/insights-games/pack-drilldown";
import { fetchPackDrilldown } from "./drilldown-actions";

/**
 * Per-pack drilldown — clicking the trigger fetches and shows the
 * five datasets (daily volume, top users, card distribution, borrow
 * split, RTP drift) for the pack in the active period. Lazy: the
 * action only runs on first open.
 *
 * Same chrome convention as the rewards-analytics popovers — Info
 * icon trigger, 480px content, lazy expanders for the heavier rows.
 *
 * House-POV coloring: wager = emerald, payout = rose, drift positive
 * = pack ran hot for users = rose / drift negative = pack ran cold =
 * emerald (matches the project-wide rule).
 */
export function PackDrilldownPopover({
  packId,
  period,
  packName,
}: {
  packId: string;
  period: string;
  packName: string;
}) {
  const [state, setState] = useState<{
    open: boolean;
    data: PackDrilldownData | null;
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
        const data = await fetchPackDrilldown(packId, period);
        if (!data) {
          setState({
            open: true,
            data: null,
            error: "Pack not found",
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
            aria-label={`Show ${packName} drilldown`}
            title={`Show ${packName} drilldown`}
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
        className="w-[480px] max-w-[calc(100vw-2rem)] space-y-3 p-3"
      >
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-cyan-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {packName}
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              Per-pack drilldown · borrow-corrected · creators-on-stream
              excluded
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

function DrilldownBody({ data }: { data: PackDrilldownData }) {
  const { rtpDrift, dailyVolume, topUsers, cardDistribution, borrowSplit } =
    data;

  // Drift > 0 means realized RTP > theoretical → users won more than
  // the pack is configured for → bad for house → rose. Drift < 0 →
  // good for house → emerald.
  const driftIsBadForHouse = rtpDrift.driftPct > 0;
  const driftColor = driftIsBadForHouse
    ? "text-rose-600 dark:text-rose-400"
    : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="space-y-3">
      {/* RTP drift mini-block — top-of-popover headline. */}
      <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/40 p-2">
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Theoretical RTP
          </p>
          <p className="font-semibold tabular-nums">
            {rtpDrift.theoreticalRtpPct.toFixed(2)}%
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Realized RTP
          </p>
          <p className="font-semibold tabular-nums">
            {rtpDrift.realizedRtpPct.toFixed(2)}%
          </p>
        </div>
        <div>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Drift
          </p>
          <p
            className={cn(
              "inline-flex items-center gap-0.5 font-semibold tabular-nums",
              driftColor,
            )}
          >
            {driftIsBadForHouse ? (
              <TrendingUp className="size-3" />
            ) : (
              <TrendingDown className="size-3" />
            )}
            {rtpDrift.driftPct >= 0 ? "+" : ""}
            {rtpDrift.driftPct.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Daily volume sparkline (table-style). */}
      <LazySection
        label={`Daily volume (${dailyVolume.length} ${dailyVolume.length === 1 ? "day" : "days"})`}
        icon={Sparkles}
      >
        {dailyVolume.length === 0 ? (
          <p className="px-1 py-1 text-[10px] text-muted-foreground/60">
            No opens in this period.
          </p>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-semibold">Day</th>
                <th className="py-1 text-right font-semibold">Opens</th>
                <th className="py-1 text-right font-semibold">Wager</th>
                <th className="py-1 text-right font-semibold">Payout</th>
                <th className="py-1 text-right font-semibold">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {dailyVolume.map((p) => (
                <tr key={p.date} className="border-t border-border/40">
                  <td className="py-1 text-muted-foreground">{p.date}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatNumber(p.opens)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatCompactUsd(p.wager)}
                  </td>
                  <td className="py-1 text-right tabular-nums text-rose-600 dark:text-rose-400">
                    {formatCompactUsd(p.payout)}
                  </td>
                  <td
                    className={cn(
                      "py-1 text-right font-medium tabular-nums",
                      p.pnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {formatCompactUsd(p.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LazySection>

      <LazySection label={`Top users (${topUsers.length})`} icon={Users}>
        {topUsers.length === 0 ? (
          <p className="px-1 py-1 text-[10px] text-muted-foreground/60">
            No active users on this pack in the period.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {topUsers.map((u, idx) => (
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
                      · {formatNumber(u.opens)} opens
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
      </LazySection>

      <LazySection
        label={`Card-pull distribution (${cardDistribution.length})`}
        icon={Sparkles}
      >
        {cardDistribution.length === 0 ? (
          <p className="px-1 py-1 text-[10px] text-muted-foreground/60">
            No card pulls in this period.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {cardDistribution.map((c, idx) => (
              <li
                key={c.cardId}
                className="flex items-center justify-between gap-2 rounded px-1 py-1 hover:bg-muted/40"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground/60 tabular-nums">
                    {idx + 1}.
                  </span>
                  {c.imageUrl ? (
                    <Image
                      src={c.imageUrl}
                      alt={c.name}
                      width={20}
                      height={28}
                      className="size-7 shrink-0 rounded-md object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="size-7 shrink-0 rounded-md bg-muted" />
                  )}
                  <span className="min-w-0 truncate text-[11px]">
                    {c.name}
                    {c.isChase && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        chase
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
                    · {formatCompactUsd(c.unitPrice)}/ea
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
                  <span className="text-muted-foreground">
                    {formatNumber(c.pulls)} pulls
                  </span>
                  <span className="min-w-[56px] text-right font-semibold text-rose-600 dark:text-rose-400">
                    {formatCompactUsd(c.totalValue)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </LazySection>

      <LazySection label="Borrow split (solo opens only)" icon={Sparkles}>
        <table className="w-full text-[11px]">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-semibold">Bucket</th>
              <th className="py-1 text-right font-semibold">Opens</th>
              <th className="py-1 text-right font-semibold">Cash wager</th>
              <th className="py-1 text-right font-semibold">Avg borrow %</th>
            </tr>
          </thead>
          <tbody>
            {borrowSplit.map((b) => (
              <tr key={b.label} className="border-t border-border/40">
                <td className="py-1 font-medium">{b.label}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatNumber(b.opens)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatCompactUsd(b.wager)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {b.label === "Borrow" && b.opens > 0
                    ? `${b.avgBorrowPct.toFixed(1)}%`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </LazySection>
    </div>
  );
}

/**
 * Collapsible section inside the drilldown popover — first one shows
 * open by default, subsequent ones start collapsed so the popover
 * doesn't get overwhelming. Same pattern as the existing rewards
 * popover expanders.
 */
function LazySection({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <Icon className="size-3" />
          {label}
        </span>
        <ChevronDown
          className={cn(
            "size-3 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
