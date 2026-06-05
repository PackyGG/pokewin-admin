import { Trophy } from "lucide-react";

import { formatNumber } from "@/lib/utils/format";
import { InfoHint } from "./info-hint";
import { BackendUnavailableHint } from "./backend-unavailable-hint";
import {
  CreatorsKpiPanel,
  CreatorsPlainHero,
  CreatorsPanelChip,
  CreatorsPanelSub,
} from "./creators-kpi-panel";

/**
 * Leaderboard-spend panel for the /creators list KPI strip.
 *
 * Reskinned onto the shared dashboard-style panel (`CreatorsKpiPanel`) so it
 * sits flush with the other KPI boxes: a tinted Card, header (Trophy icon +
 * ⓘ hint + the "backend unavailable" affordance), a rose HERO, and a 2-chip
 * breakdown row. Answers the owner's question in one glance — what we're
 * committed to on creator leaderboards RIGHT NOW vs what we've already spent
 * on finished boards.
 *
 *   • Active now — rose HERO: the house-covered cost of the boards running
 *     at this moment (what we're committed to pay right now). Sub-line:
 *     "· N active · X% we pay" — the active board count + the blended house
 *     share across them (the % of the active pool we actually cover).
 *   • Past — a chip: the house-covered cost of boards whose run has finished
 *     (what we already spent on old boards), with its board count.
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
  backendUnavailable = false,
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
  /**
   * True when the backend leaderboards read failed/timed out — the figures
   * are all null and this surfaces the inline "backend unavailable" hint so
   * the "—" reads as "can't load" rather than "$0 spent". This box is 100%
   * backend-sourced (affiliateLeaderboardsApi), so it's all-or-nothing.
   */
  backendUnavailable?: boolean;
}) {
  // Active sub-line: "Active now · N active · X% we pay". The count always
  // shows when known; the "% we pay" only joins when there's an active board
  // (a 0% line on an empty board set reads as noise).
  const subParts: string[] = ["Active now"];
  if (activeCount != null) {
    subParts.push(`${formatNumber(activeCount)} active`);
  }
  if (activeCount != null && activeCount > 0 && activeCoveragePct != null) {
    subParts.push(`${activeCoveragePct.toFixed(0)}% we pay`);
  }
  const pastLabel =
    pastCount != null && pastCount > 0
      ? `Past · ${formatNumber(pastCount)} board${pastCount === 1 ? "" : "s"}`
      : "Past spent";

  return (
    <CreatorsKpiPanel
      title="Leaderboard Spend"
      icon={Trophy}
      tint="rose"
      titleAdornment={<InfoHint text={INFO_TEXT} />}
      headerRight={backendUnavailable ? <BackendUnavailableHint /> : undefined}
    >
      <CreatorsPlainHero
        value={activeHouseCostUsd}
        format="currency"
        className="text-rose-400"
      />
      <CreatorsPanelSub>{subParts.join(" · ")}</CreatorsPanelSub>
      {/* Past spend — one chip (the active figure is the hero above). */}
      <div className="grid grid-cols-1 gap-1.5 -mx-0.5">
        <CreatorsPanelChip
          label={pastLabel}
          value={pastHouseCostUsd}
          tone="rose"
        />
      </div>
    </CreatorsKpiPanel>
  );
}
