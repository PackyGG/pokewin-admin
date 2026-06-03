import { Trophy } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { TILE_COLORS } from "@/components/modern-panels";
import { InfoHint } from "./info-hint";

/**
 * Leaderboard-spend tile for the /creators list KPI strip.
 *
 * A COMPACT, single-cell tile (mirrors the <KpiTile> chrome — same border,
 * accent bar, glassy sheen) that answers the owner's question in one glance:
 * what we're committed to on creator leaderboards RIGHT NOW vs what we've
 * already spent on finished boards.
 *
 *   • Active now — rose HERO: the house-covered cost of the boards running
 *     at this moment (what we're committed to pay right now). Sub-line:
 *     "· N active · X% we pay" — the active board count + the blended house
 *     share across them (the % of the active pool we actually cover).
 *   • Past: $Y spent — a muted secondary line: the house-covered cost of
 *     boards whose run has finished (what we already spent on old boards).
 *
 * House-POV: every dollar paid to players is a house cost → rose. The active
 * gross pool (the 100% the creator partly funds off-site) is NOT shown as a
 * figure here — the box is about OUR cost; the % already conveys our slice.
 *
 * Server-safe: serializable props only + the string-only <InfoHint> client
 * component (no function props cross the RSC boundary).
 */

const INFO_TEXT =
  "Active now = the house-covered cost of the creator leaderboards running right now (what we're committed to pay). “X% we pay” is the house's sponsored share of those active boards — the creator funds the rest off-site. Past = what we already spent on finished boards. Net of refunds; money paid to players = house cost (rose).";

export function LeaderboardSpendPanel({
  activeHouseCostUsd,
  activeCoveragePct,
  activeCount,
  pastHouseCostUsd,
  pastCount,
}: {
  /** House-covered cost of boards running right now — the rose hero. */
  activeHouseCostUsd: number | null;
  /** Blended house share across the active boards ("% we pay"). */
  activeCoveragePct: number | null;
  /** Count of boards running right now. */
  activeCount: number | null;
  /** House-covered cost of finished boards — the muted "Past" line. */
  pastHouseCostUsd: number | null;
  /** Count of finished boards. */
  pastCount: number | null;
}) {
  const rose = TILE_COLORS.rose;

  // Active sub-line: "· N active · X% we pay". The count always shows when
  // known; the "% we pay" only joins when there's an active board (a 0%
  // line on an empty board set reads as noise).
  const subParts: string[] = [];
  if (activeCount != null) {
    subParts.push(`${formatNumber(activeCount)} active`);
  }
  if (activeCount != null && activeCount > 0 && activeCoveragePct != null) {
    subParts.push(`${activeCoveragePct.toFixed(0)}% we pay`);
  }
  const activeSub = subParts.length > 0 ? subParts.join(" · ") : null;

  return (
    <div
      className={cn(
        "hover-raise group surface-sheen relative overflow-hidden rounded-xl border px-3 py-2.5 sm:px-4 sm:py-3",
        rose.bg,
      )}
    >
      {/* Left accent bar — rose (house cost), matching <KpiTile>. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50 transition-opacity duration-200 group-hover:opacity-80",
          rose.icon,
        )}
      />
      {/* Glassy diagonal sheen — neutral white so it never fights the
          House-POV rose accent. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent"
      />

      {/* Header row — icon + label + the ⓘ hint in the top-right. */}
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Trophy className={cn("size-3.5 shrink-0 sm:size-4", rose.icon)} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            Leaderboard Spend
          </span>
        </div>
        <div className="shrink-0">
          <InfoHint text={INFO_TEXT} />
        </div>
      </div>

      {/* Hero — Active now (rose house cost). */}
      <p
        className={cn(
          "relative mt-1 truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
          rose.text,
        )}
      >
        {activeHouseCostUsd != null ? formatCurrency(activeHouseCostUsd) : "—"}
      </p>
      <p className="relative mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
        Active now
        {activeSub ? ` · ${activeSub}` : ""}
      </p>

      {/* Secondary — what we already spent on finished boards. */}
      <p className="relative mt-1 truncate text-[10px] text-muted-foreground sm:text-[11px]">
        Past:{" "}
        <span className="font-medium tabular-nums text-foreground/70">
          {pastHouseCostUsd != null ? formatCurrency(pastHouseCostUsd) : "—"}
        </span>{" "}
        spent
        {pastCount != null && pastCount > 0
          ? ` · ${formatNumber(pastCount)} board${pastCount === 1 ? "" : "s"}`
          : ""}
      </p>
    </div>
  );
}
