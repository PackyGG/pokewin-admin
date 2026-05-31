import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils/format";

type Props = {
  wagerVolumeUsd: number;
  /**
   * Per-game-type slice of `wagerVolumeUsd` — packs + battles +
   * upgrader sum to it exactly. Rendered as indented sub-rows beneath
   * the Wager Volume row so the operator can see at a glance how much
   * of this creator's wager volume came from packs / battles vs the
   * upgrader. Optional so the legacy callers that don't pass it still
   * render the original 5-row layout.
   */
  wagerBreakdown?: {
    packs: number;
    battles: number;
    upgrader: number;
  };
  earnedUsd: number;
  availableUsd: number;
  paidOutUsd: number;
  bonusDistributedUsd: number;
};

export function FinancialsCard({
  wagerVolumeUsd,
  wagerBreakdown,
  earnedUsd,
  availableUsd,
  paidOutUsd,
  bonusDistributedUsd,
}: Props) {
  // The "Wager Volume" row is now followed by an inline two-tier
  // breakdown when wagerBreakdown is passed. We render the row list
  // explicitly below instead of mapping a flat array so the indent +
  // styling on the breakdown rows can differ from the headline rows
  // without conditionals in a map. Packs + Battles are bucketed under
  // a shared "Packs & Battles" row to match the way the dashboard's
  // wager card pairs them (both are pack-style gameplay), with
  // Upgrader called out separately.
  const packsAndBattles =
    wagerBreakdown != null
      ? wagerBreakdown.packs + wagerBreakdown.battles
      : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-card-title">Financials</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cumulative, all-time
        </p>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        <dl className="divide-y divide-border/60">
          <div className="flex items-center justify-between py-2 first:pt-0">
            <dt className="text-xs text-muted-foreground">Wager Volume</dt>
            <dd className="text-sm tabular-nums">
              {formatCurrency(wagerVolumeUsd)}
            </dd>
          </div>
          {wagerBreakdown != null && packsAndBattles != null && (
            // No divider above this block — it reads as an indented
            // continuation of the Wager Volume row above. The two
            // sub-rows are tiny ("•" leader, dim text) so the
            // breakdown doesn't visually compete with the headline
            // total.
            <div className="space-y-1 py-1.5 pl-3 text-[11px]">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="opacity-60">
                    •
                  </span>
                  Packs &amp; Battles
                </span>
                <span className="tabular-nums">
                  {formatCurrency(packsAndBattles)}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="opacity-60">
                    •
                  </span>
                  Upgrader
                </span>
                <span className="tabular-nums">
                  {formatCurrency(wagerBreakdown.upgrader)}
                </span>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between py-2">
            <dt className="text-xs text-muted-foreground">Total Earned</dt>
            <dd className="text-sm tabular-nums">
              {formatCurrency(earnedUsd)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt className="text-xs text-muted-foreground">Available</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {formatCurrency(availableUsd)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt className="text-xs text-muted-foreground">Paid Out</dt>
            <dd className="text-sm tabular-nums">{formatCurrency(paidOutUsd)}</dd>
          </div>
          <div className="flex items-center justify-between py-2 last:pb-0">
            <dt className="text-xs text-muted-foreground">Bonus Distributed</dt>
            <dd className="text-sm tabular-nums">
              {formatCurrency(bonusDistributedUsd)}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
