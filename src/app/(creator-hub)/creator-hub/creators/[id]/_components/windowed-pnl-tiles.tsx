import { Info, LineChart, TrendingDown, TrendingUp } from "lucide-react";

import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { getCreatorPnlCached } from "../_queries/overview-data";

/**
 * Small windowed P&L tiles — 1d / 3d / 7d / 2w / 1m. Owner spec: the small
 * windowed boxes only, NOT the big lifetime box (the Creator Net panel
 * already carries the lifetime/net figure).
 *
 *   pnl = cohort deposits − card withdrawals  (per window)
 *
 * House-POV: pnl > 0 (we kept more cash than card value shipped) → emerald;
 * pnl < 0 → rose. Driven by the existing `getCreatorPnlCached` per-window
 * ledger scan (cached, prod-pinned). Best-effort: a failed/timed-out scan
 * degrades to a compact "unavailable" banner for this band only.
 */

const DISPLAYED_PERIODS: Array<{
  key: "24h" | "3d" | "7d" | "14d" | "30d";
  label: string;
  sub: string;
}> = [
  { key: "24h", label: "1d", sub: "Last 24 hours" },
  { key: "3d", label: "3d", sub: "Last 3 days" },
  { key: "7d", label: "7d", sub: "Last week" },
  { key: "14d", label: "2w", sub: "Last 2 weeks" },
  { key: "30d", label: "1m", sub: "Last month" },
];

export async function WindowedPnlTiles({ userId }: { userId: string }) {
  // Match the existing CreatorPnlPanel's 60s budget so the cold populating
  // scan completes + warms the cache rather than getting cut off early.
  const { data } = await safeQueryOrNull(
    () => getCreatorPnlCached(userId),
    "creator-hub.creators.pnl",
    60_000,
  );

  if (!data) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <Info className="size-4 mt-0.5 text-amber-500 shrink-0" />
        <div>
          <div className="font-medium text-amber-500">
            Windowed P&amp;L is taking too long to load
          </div>
          <div className="mt-0.5 text-muted-foreground">
            The per-window deposit / card-withdrawal scan timed out. Refresh to
            retry — the rest of the page is unaffected.
          </div>
        </div>
      </div>
    );
  }

  const byPeriod = new Map(data.byPeriod.map((p) => [p.period, p]));

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {DISPLAYED_PERIODS.map(({ key, label, sub }) => {
        const row = byPeriod.get(key);
        const pnl = row?.pnl ?? 0;
        const deposits = row?.deposits ?? 0;
        const wagered = row?.wagered ?? 0;
        const cardWithdrawals = row?.cardWithdrawals ?? 0;
        const isWin = pnl > 0;
        const isLoss = pnl < 0;
        const accent: "emerald" | "rose" | "blue" = isWin
          ? "emerald"
          : isLoss
            ? "rose"
            : "blue";
        return (
          <StatPanel
            key={key}
            title={label}
            icon={isWin ? TrendingUp : isLoss ? TrendingDown : LineChart}
            accent={accent}
          >
            <div className="space-y-1.5">
              <div
                className={cn(
                  "text-xl font-bold tabular-nums leading-none",
                  isWin
                    ? "text-emerald-600 dark:text-emerald-400"
                    : isLoss
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                )}
                title={`House P&L — ${sub}`}
              >
                {pnl === 0 ? "—" : formatCurrency(pnl)}
              </div>
              <p className="text-[10px] text-muted-foreground">{sub}</p>
            </div>
            <div className="mt-3 space-y-0.5">
              <PanelRow
                label="Deposits"
                value={deposits === 0 ? "—" : formatCurrency(deposits)}
                valueClassName={
                  deposits > 0 ? "text-emerald-600 dark:text-emerald-400" : ""
                }
              />
              <PanelRow
                label="Wagered"
                value={wagered === 0 ? "—" : formatCurrency(wagered)}
                valueClassName="text-muted-foreground"
              />
              <PanelRow
                label="Card WD"
                value={
                  cardWithdrawals === 0 ? "—" : formatCurrency(cardWithdrawals)
                }
                valueClassName={
                  cardWithdrawals > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : ""
                }
              />
            </div>
          </StatPanel>
        );
      })}
    </div>
  );
}

export function WindowedPnlTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {[0, 1, 2, 3, 4].map((i) => (
        <Card key={i} size="sm" className="space-y-2 p-4">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-20" />
          <div className="space-y-1.5 pt-1">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}
