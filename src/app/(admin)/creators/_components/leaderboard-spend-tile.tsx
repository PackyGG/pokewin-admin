import { Trophy } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { TILE_COLORS } from "@/components/modern-panels";
import { InfoHint } from "./info-hint";

/**
 * Leaderboard-spend display box for the /creators list KPI strip.
 *
 * Surfaces BOTH scopes of creator-leaderboard spend in one tile — the
 * single `KpiTile` only has room for one figure + a truncated sub-line,
 * so this purpose-built box (matching the KpiTile chrome: border, accent
 * bar, glassy sheen) stacks them:
 *
 *   • House covered — the sponsored share the house actually pays. This
 *     is the hero number, House-POV ROSE: money paid to players is a
 *     house cost. Mirrors the rose total-prize coloring on the
 *     /creators/leaderboards table.
 *   • Total prizes (100%) — the full committed prize pool. NEUTRAL
 *     context (muted): the creator funds the non-sponsored slice
 *     off-site, so the full pool isn't all our cost.
 *   • Effective % we cover (covered / total) — only shown when there's a
 *     pool to divide AND the share is actually a fraction (< 100%); at
 *     the 100% default it's redundant with "all of it".
 *
 * Server-safe: takes serializable number props + renders the string-only
 * <InfoHint> client component (no function props cross the RSC boundary).
 */
export function LeaderboardSpendTile({
  totalPrizeUsd,
  houseCoveredUsd,
}: {
  /** Full 100% prize pool committed (net of refunds), no weighting. */
  totalPrizeUsd: number | null;
  /** The house's sponsored share — the actual house cost (rose). */
  houseCoveredUsd: number | null;
}) {
  const rose = TILE_COLORS.rose;
  // Effective coverage % = covered / total. Only meaningful when there's
  // a non-zero pool; suppressed at (or above) 100% where it reads as
  // redundant noise next to "Total prizes (100%)".
  const effectivePct =
    totalPrizeUsd != null && houseCoveredUsd != null && totalPrizeUsd > 0
      ? (houseCoveredUsd / totalPrizeUsd) * 100
      : null;
  const showPct = effectivePct != null && effectivePct < 99.95;

  return (
    <div
      className={cn(
        "hover-raise group surface-sheen relative overflow-hidden rounded-xl border px-3 py-2.5 sm:px-4 sm:py-3",
        rose.bg,
      )}
    >
      {/* Left accent bar + glassy sheen — identical treatment to KpiTile
          so this box reads as one family with the rest of the strip. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50 transition-opacity duration-200 group-hover:opacity-80",
          rose.icon,
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent"
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Trophy className={cn("size-3.5 shrink-0 sm:size-4", rose.icon)} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            Leaderboard Spend
          </span>
        </div>
        <div className="shrink-0">
          <InfoHint text="100% = the full creator-leaderboard prize pool committed (net of refunds). House covered = our sponsored share — the part we actually pay; the rest is funded by the creator off-site. Weighted by each approved board's admin-set house %. Money paid to players = house cost (rose)." />
        </div>
      </div>
      {/* House covered — hero figure, rose (house cost). */}
      <p
        className={cn(
          "relative mt-1 truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
          rose.text,
        )}
      >
        {houseCoveredUsd != null ? formatCurrency(houseCoveredUsd) : "—"}
      </p>
      <p className="relative mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
        House covered{showPct ? ` · ${effectivePct!.toFixed(0)}% of pool` : ""}
      </p>
      {/* Total prizes (100%) — neutral context, secondary line. Set off
          with a hairline divider so it reads as a distinct figure, not a
          continuation of the house-covered sub-line. */}
      <div className="relative mt-2 border-t border-border/50 pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[10px] text-muted-foreground sm:text-[11px]">
            Total prizes (100%)
          </span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground/80 sm:text-base">
            {totalPrizeUsd != null ? formatCurrency(totalPrizeUsd) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
