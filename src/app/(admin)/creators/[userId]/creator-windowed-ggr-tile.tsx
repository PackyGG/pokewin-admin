import { Coins } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import {
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard-period";
import { cn } from "@/lib/utils";
import { safeQueryOrNull } from "@/lib/errors/safe-query";

import {
  getCreatorCodeUserGgrForPeriod,
  type CreatorCodeUserGgr,
} from "./_queries/creator-net-pnl";
import { InfoHint } from "../_components/info-hint";

/**
 * Windowed Code-User GGR trend — the SECONDARY, period-driven view of the
 * Net Creator P&L band. Split OUT of `CreatorNetPnlPanel` into its own
 * async server component so it can sit behind its OWN `<Suspense key=
 * {period}>` boundary: a `?period=` chip switch re-streams ONLY this single
 * cohort-GGR read, never the (lifetime) net + 4-source cost the rest of the
 * panel computes. Active-timeframe-only — exactly one window per render,
 * the active `?period=`; nothing is pre-computed across windows.
 *
 * Lifetime fallback: when the chip is "all" the windowed GGR equals the
 * lifetime GGR the panel already shows, so the parent renders the lifetime
 * value directly and never mounts this component — we never fire a
 * redundant read. For every other window this fetches just the windowed
 * cohort GGR (no cost round-trip).
 *
 * `lifetimeGgr` is the panel's already-resolved lifetime GGR, passed in so
 * a timed-out / failed windowed read degrades to the lifetime figure
 * (labelled as such) instead of blanking the tile.
 *
 * House POV (per CLAUDE.md): GGR > 0 → cohort lost / paid in → 🟢 emerald.
 */
export async function CreatorWindowedGgrTile({
  userId,
  period,
  lifetimeGgr,
}: {
  userId: string;
  period: DashboardPeriod;
  lifetimeGgr: CreatorCodeUserGgr;
}) {
  // Active-timeframe-only. For "all" the windowed GGR IS the lifetime GGR
  // the parent already resolved — render it directly, never fire a
  // redundant read. For every other window do a SINGLE windowed cohort-GGR
  // read, timeout-bounded so a pathological scan degrades to the lifetime
  // fallback rather than hanging this Suspense segment (the rest of the
  // page already streamed).
  const isAll = period === "all";
  const { data: windowedGgrRaw } = isAll
    ? { data: lifetimeGgr }
    : await safeQueryOrNull(
        () => getCreatorCodeUserGgrForPeriod(userId, period),
        "creators.netPnl.windowedGgr",
        15_000,
      );

  const windowedGgr = windowedGgrRaw ?? lifetimeGgr;
  const windowLabel = DASHBOARD_PERIOD_LABELS[period];
  // A failed/timed-out read only matters for a real window (for "all" the
  // lifetime value is authoritative, not a fallback).
  const failed = !isAll && windowedGgrRaw == null;

  return (
    <StatPanel
      title={`Code-User GGR · ${windowLabel}`}
      icon={Coins}
      accent={
        windowedGgr.ggr > 0 ? "emerald" : windowedGgr.ggr < 0 ? "rose" : "blue"
      }
      action={
        <InfoHint
          text="Windowed code-user GGR (wager − payout) for this creator's cohort over the period chip above — a trend signal only. It is NOT netted against the lifetime Creator Cost, so don't read it as a windowed Net PnL."
          side="left"
        />
      }
    >
      <div className="space-y-1">
        <div
          className={cn(
            "text-2xl font-bold tabular-nums leading-none sm:text-3xl",
            windowedGgr.ggr > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : windowedGgr.ggr < 0
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
          )}
          title={`Code-User GGR over ${windowLabel} — wager minus gaming payout (House POV)`}
        >
          {windowedGgr.ggr === 0 ? "—" : formatCurrency(windowedGgr.ggr)}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Windowed ({windowLabel}) cohort gaming margin — wager − payout.
          {failed && (
            <span className="text-rose-500">
              {" "}
              (windowed read failed — showing lifetime)
            </span>
          )}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-0.5">
        <PanelRow
          label="Wager"
          value={
            windowedGgr.wager === 0 ? "—" : formatCurrency(windowedGgr.wager)
          }
          valueClassName={
            windowedGgr.wager > 0 ? "text-emerald-600 dark:text-emerald-400" : ""
          }
        />
        <PanelRow
          label="Gaming payout"
          value={
            windowedGgr.gamingPayout === 0
              ? "—"
              : formatCurrency(windowedGgr.gamingPayout)
          }
          valueClassName="text-muted-foreground"
        />
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground">
        GGR is window-scoped (driven by the chip above). Creator Cost is
        always lifetime, so this windowed GGR is a trend signal — not netted
        against the lifetime cost. Same canonical attribution +
        staff/blacklist scope as the dashboard / /ggr GGR, narrowed to this
        creator&apos;s code cohort.
      </p>
    </StatPanel>
  );
}

/** Skeleton matching the windowed-GGR StatPanel — shown while a chip switch
 *  re-streams just this tile. */
export function CreatorWindowedGgrSkeleton() {
  return (
    <div className="space-y-3 rounded-2xl border bg-card/40 p-4 sm:p-5">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="h-8 w-32 animate-pulse rounded bg-muted" />
      <div className="h-3 w-56 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 pt-1">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
