"use client";

import * as React from "react";
import { Layers, Coins, Activity, Flame, ArrowRight } from "lucide-react";

import { KpiTile, type AccentColor } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { AnimatedNumber } from "@/components/animated-number";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { PortfolioProfileResult } from "../doctor/retune-actions";
import type { PortfolioSystemPlan } from "../_lib/portfolio";

/**
 * System Balance header — the catalog-level risk profile for the WHOLE active
 * pack portfolio, the read that backs the "Balance whole system" toggle.
 *
 * Shows four headline KPIs (pack count, total max-win exposure vs the bankroll
 * cap, aggregate CV, spicy share), a compact within-bounds verdict, and — when
 * system-balance mode is ON — the `systemPlan`'s before→after projection plus the
 * list of which packs were tightened + why, so the owner understands the
 * cross-pack balancing. The volatility tier-distribution histogram that used to
 * sit here was moved to the Pack Studio Overview ("Risk system" box) so the
 * single-pack review stays focused.
 *
 * House-POV coloring: exposure ABOVE its cap and a spicy share ABOVE its bound
 * are house RISK → rose; inside the bound is healthy → emerald.
 * Pure presentation over serializable props (no function props cross the RSC
 * boundary; numbers animate via the `formatKind`-enum `AnimatedNumber`).
 */

export function SystemBalancePanel({
  portfolio,
  systemPlan,
  portfolioMode,
}: {
  portfolio: PortfolioProfileResult;
  /** The system plan when balance mode is on; null in per-pack mode. */
  systemPlan: PortfolioSystemPlan | null;
  portfolioMode: boolean;
}) {
  const { cfg, profile, withinBounds } = portfolio;

  // House-POV: over the exposure cap / spicy bound = house risk = rose.
  const exposureOver = profile.totalMaxWinExposure > cfg.exposureCapUsd;
  const spicyOver = profile.spicyShare > cfg.maxSpicyShare;
  const exposurePct =
    cfg.exposureCapUsd > 0
      ? Math.min(100, (profile.totalMaxWinExposure / cfg.exposureCapUsd) * 100)
      : 0;

  return (
    <div className="space-y-3">
      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <KpiTile
          label="Packs in catalog"
          value={formatNumber(profile.packCount)}
          icon={Layers}
          accent="blue"
          sub={`${profile.countBelowTarget} below edge target`}
        />
        <KpiTile
          label="Max-win exposure"
          value={formatCurrency(profile.totalMaxWinExposure)}
          icon={Coins}
          accent={exposureOver ? "rose" : "emerald"}
          sub={`${exposurePct.toFixed(0)}% of ${formatCurrency(cfg.exposureCapUsd)} cap`}
        />
        <KpiTile
          label="Aggregate CV"
          value={profile.aggregateCv.toFixed(2)}
          icon={Activity}
          accent="cyan"
          sub="price-weighted volatility"
        />
        <KpiTile
          label="Spicy share"
          value={`${(profile.spicyShare * 100).toFixed(0)}%`}
          icon={Flame}
          accent={spicyOver ? "rose" : "emerald"}
          sub={`T4+T5 · cap ${(cfg.maxSpicyShare * 100).toFixed(0)}%`}
        />
      </div>

      {/* Bounds verdict — the functional pass/fail for the whole catalog. The
          tier-distribution histogram that used to live here was moved to the Pack
          Studio Overview ("Risk system" box) so the single-pack review stays
          focused; only the actionable verdict remains. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2.5 sm:px-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Catalog within system bounds
        </p>
        <Badge
          variant="outline"
          className={cn(
            "h-5 px-1.5 text-[10px]",
            withinBounds
              ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400",
          )}
        >
          {withinBounds ? "Within bounds" : "Over bounds"}
        </Badge>
      </div>

      {/* System plan — only when balance mode is on */}
      {portfolioMode && systemPlan && (
        <SystemPlanPanel plan={systemPlan} />
      )}
    </div>
  );
}

function SystemPlanPanel({ plan }: { plan: PortfolioSystemPlan }) {
  const { before, projectedAfter, tightened, withinBounds } = plan;
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          System balance plan
        </p>
        <Badge
          variant="outline"
          className={cn(
            "h-5 px-1.5 text-[10px]",
            withinBounds
              ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
          )}
        >
          {withinBounds ? "Projected within bounds" : "Still over after tightening"}
        </Badge>
      </div>

      {/* Before → projected-after deltas */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <BeforeAfterRow
          label="Spicy share"
          before={before.spicyShare * 100}
          after={projectedAfter.spicyShare * 100}
          kind="percent"
          lowerIsHouseGood
        />
        <BeforeAfterRow
          label="Max-win exposure"
          before={before.totalMaxWinExposure}
          after={projectedAfter.totalMaxWinExposure}
          kind="currency"
          lowerIsHouseGood
        />
      </div>

      {tightened.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          The catalog already fits its system bounds — no packs needed tightening.
        </p>
      ) : (
        <div className="mt-3 space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {tightened.length} pack{tightened.length === 1 ? "" : "s"} tightened
          </p>
          <ul className="space-y-1">
            {tightened.slice(0, 6).map((t) => (
              <li
                key={t.packId}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="font-medium tabular-nums">
                  win {(t.winRateBefore * 100).toFixed(0)}%
                </span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                  {(t.winRateAfter * 100).toFixed(0)}%
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="font-medium tabular-nums">
                  cap {formatCurrency(t.maxWinCapBefore)}
                </span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(t.maxWinCapAfter)}
                </span>
                <span className="ml-auto truncate text-muted-foreground">
                  {t.reason}
                </span>
              </li>
            ))}
          </ul>
          {tightened.length > 6 && (
            <p className="text-[11px] text-muted-foreground">
              +{tightened.length - 6} more tightened in this plan.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function BeforeAfterRow({
  label,
  before,
  after,
  kind,
  lowerIsHouseGood,
}: {
  label: string;
  before: number;
  after: number;
  kind: "percent" | "currency";
  /** When true, a DROP (after < before) is house-good → emerald; a rise → rose. */
  lowerIsHouseGood: boolean;
}) {
  const changed = Math.abs(after - before) > 1e-9;
  const houseGood = lowerIsHouseGood ? after < before : after > before;
  const accent: AccentColor = !changed ? "blue" : houseGood ? "emerald" : "rose";
  const tone =
    accent === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : accent === "rose"
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 text-sm font-medium tabular-nums">
        <span className="text-muted-foreground">
          {kind === "currency" ? formatCurrency(before) : `${before.toFixed(0)}%`}
        </span>
        <ArrowRight className="size-3 text-muted-foreground" />
        <AnimatedNumber value={after} format={kind} className={tone} />
      </span>
    </div>
  );
}
