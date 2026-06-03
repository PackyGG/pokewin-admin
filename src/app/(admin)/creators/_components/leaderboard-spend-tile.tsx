import { Trophy } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { StatPanel, TILE_COLORS } from "@/components/modern-panels";
import type { LeaderboardCostBoard } from "../_queries/leaderboard-cost";
import { InfoHint } from "./info-hint";

/**
 * Leaderboard-spend panel for the /creators list KPI strip.
 *
 * A wider `StatPanel`-style box (spans 2 grid columns on the strip) that
 * surfaces every scope of creator-leaderboard spend in one place — the
 * removal of the Active Deals + Live Now tiles freed the room for the
 * detail. House-POV throughout: money paid to players is a house cost
 * (rose); the full pool is neutral context.
 *
 * Headline figures:
 *   • House covered — the sponsored share the house actually pays. Hero
 *     number, ROSE (house cost). Mirrors the rose total-prize coloring
 *     on the /creators/leaderboards table.
 *   • Total prizes (100%) — the full committed prize pool, net of
 *     refunds. NEUTRAL: the creator funds the non-sponsored slice
 *     off-site, so the full pool isn't all our cost.
 *   • Effective coverage % — covered / total. Only shown when there's a
 *     pool AND the share is a real fraction (< 100%); at the 100%
 *     default it's redundant with "all of it".
 *   • Approved boards — how many APPROVED creator leaderboards the
 *     figures sum across.
 *
 * Per-board mini-breakdown: the top boards by house cost (creator-board
 * name, prize pool, house %, house cost), with a "+N more" line when the
 * full set is longer. The board list arrives pre-sorted (priciest first)
 * from the SAME walk that computes the totals — no extra query.
 *
 * Server-safe: takes serializable props + renders the string-only
 * <InfoHint> client component (no function props cross the RSC boundary).
 */

// How many boards the mini-breakdown lists before collapsing the rest
// into a "+N more" line. Keeps the panel compact next to the KPI tiles.
const TOP_BOARDS = 3;

const INFO_TEXT =
  "100% = the full creator-leaderboard prize pool committed (net of refunds). House covered = our sponsored share — the part we actually pay; the rest is funded by the creator off-site. Weighted by each approved board's admin-set house %. Money paid to players = house cost (rose).";

export function LeaderboardSpendPanel({
  totalPrizeUsd,
  houseCoveredUsd,
  boardCount,
  boards,
}: {
  /** Full 100% prize pool committed (net of refunds), no weighting. */
  totalPrizeUsd: number | null;
  /** The house's sponsored share — the actual house cost (rose). */
  houseCoveredUsd: number | null;
  /** Count of APPROVED creator leaderboards behind the figures. */
  boardCount: number | null;
  /**
   * Per-board contributions, pre-sorted by house cost DESC. Empty when
   * the query failed or there are no approved boards.
   */
  boards: LeaderboardCostBoard[];
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

  const topBoards = boards.slice(0, TOP_BOARDS);
  const remaining = Math.max(0, boards.length - topBoards.length);

  return (
    <StatPanel
      title="Leaderboard Spend"
      icon={Trophy}
      accent="rose"
      action={<InfoHint text={INFO_TEXT} />}
    >
      {/* Hero — House covered (rose house cost) + effective-% sub-line. */}
      <p
        className={cn(
          "truncate text-2xl font-bold leading-none tracking-tight tabular-nums sm:text-3xl",
          rose.text,
        )}
      >
        {houseCoveredUsd != null ? formatCurrency(houseCoveredUsd) : "—"}
      </p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground sm:text-xs">
        House covered
        {showPct ? ` · ${effectivePct!.toFixed(0)}% of pool` : ""}
      </p>

      {/* Headline secondary figures — total pool (neutral), coverage %,
          and the approved-board count. */}
      <div className="mt-3 space-y-0.5 border-t border-border/50 pt-2">
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">
            Total prizes (100%)
          </span>
          <span className="shrink-0 font-medium tabular-nums text-foreground/80">
            {totalPrizeUsd != null ? formatCurrency(totalPrizeUsd) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">
            Effective coverage
          </span>
          <span className="shrink-0 font-medium tabular-nums text-foreground/80">
            {effectivePct != null ? `${effectivePct.toFixed(0)}%` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">
            Approved boards
          </span>
          <span className="shrink-0 font-medium tabular-nums text-foreground/80">
            {boardCount != null ? formatNumber(boardCount) : "—"}
          </span>
        </div>
      </div>

      {/* Per-board mini-breakdown — top boards by house cost. Each row:
          board name + house % chip (left), prize pool (muted) + house
          cost (rose) (right). Collapses the tail into a "+N more" line. */}
      {topBoards.length > 0 && (
        <div className="mt-3 border-t border-border/50 pt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Top boards by house cost
          </p>
          <ul className="space-y-1.5">
            {topBoards.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-foreground/90">
                    {b.name || "Untitled board"}
                  </span>
                  <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">
                    {b.sponsoredPct.toFixed(0)}%
                  </span>
                </div>
                <div className="flex shrink-0 items-baseline gap-2 tabular-nums">
                  <span className="text-muted-foreground/70">
                    {formatCurrency(b.prizeUsd)}
                  </span>
                  <span className={cn("font-semibold", rose.text)}>
                    {formatCurrency(b.houseCostUsd)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              +{formatNumber(remaining)} more board
              {remaining === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </StatPanel>
  );
}
