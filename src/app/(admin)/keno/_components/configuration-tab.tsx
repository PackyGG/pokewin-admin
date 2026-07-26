import {
  Calculator,
  Dices,
  Grid3X3,
  ShieldCheck,
  WalletCards,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  PanelRow,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import {
  getCachedLeaderboardWagerWeights,
  getCachedRakebackWagerWeights,
  getCachedWagerRequirementDefaults,
} from "../../security/_cached-reads";
import {
  getKenoRtp,
  KENO_DRAW_COUNT,
  KENO_GRID_SIZE,
  KENO_MAX_BET_USD,
  KENO_MAX_PICKS,
  KENO_MIN_BET_USD,
  KENO_MIN_PICKS,
  KENO_RISK_MODES,
} from "@/lib/keno/payouts";
import { KenoSettingsCard } from "./keno-settings-card";

export async function KenoConfigurationTab({
  canEdit,
}: {
  canEdit: boolean;
}) {
  const [wagerResult, leaderboardResult, rakebackResult] =
    await Promise.allSettled([
      getCachedWagerRequirementDefaults(),
      getCachedLeaderboardWagerWeights(),
      getCachedRakebackWagerWeights(),
    ]);

  const wagerDefaults =
    wagerResult.status === "fulfilled" ? wagerResult.value : null;
  const leaderboardWeights =
    leaderboardResult.status === "fulfilled" ? leaderboardResult.value : null;
  const rakebackWeights =
    rakebackResult.status === "fulfilled" ? rakebackResult.value : null;
  const configuredRtps = KENO_RISK_MODES.flatMap((risk) =>
    Array.from(
      { length: KENO_MAX_PICKS - KENO_MIN_PICKS + 1 },
      (_, index) => getKenoRtp(risk, KENO_MIN_PICKS + index),
    ),
  );
  const minRtp = Math.min(...configuredRtps);
  const maxRtp = Math.max(...configuredRtps);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading
          icon={Dices}
          title="Live Keno controls"
          action={
            <Badge variant="outline" className="font-normal">
              {canEdit ? "Admin editing enabled" : "Read only"}
            </Badge>
          }
        />
        <KenoSettingsCard
          wagerDefaults={wagerDefaults}
          leaderboardWeights={leaderboardWeights}
          rakebackWeights={rakebackWeights}
          canEdit={canEdit}
        />
      </section>

      <section className="space-y-3">
        <SectionHeading icon={Grid3X3} title="Fixed game rules" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatPanel title="Draw" icon={Grid3X3} accent="purple">
            <PanelRow
              label="Backend positions"
              value={`0–${KENO_GRID_SIZE - 1}`}
            />
            <PanelRow label="Numbers drawn" value={String(KENO_DRAW_COUNT)} />
            <PanelRow
              label="Player picks"
              value={`${KENO_MIN_PICKS}–${KENO_MAX_PICKS}`}
            />
          </StatPanel>
          <StatPanel title="Stake" icon={WalletCards} accent="amber">
            <PanelRow
              label="Minimum bet"
              value={`$${KENO_MIN_BET_USD.toFixed(2)}`}
            />
            <PanelRow
              label="Maximum bet"
              value={`$${KENO_MAX_BET_USD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
            />
            <PanelRow label="Settlement" value="Immediate" />
          </StatPanel>
          <StatPanel title="Risk" icon={ShieldCheck} accent="cyan">
            <PanelRow label="Low" value="Frequent returns" />
            <PanelRow label="Medium" value="Balanced curve" />
            <PanelRow label="High" value="Concentrated upside" />
          </StatPanel>
          <StatPanel title="Payout math" icon={Calculator} accent="emerald">
            <PanelRow label="Configured curves" value="30" />
            <PanelRow
              label="RTP range"
              value={`${(minRtp * 100).toFixed(2)}–${(maxRtp * 100).toFixed(2)}%`}
            />
            <PanelRow label="Maximum multiplier" value="1,000.00×" />
          </StatPanel>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          These rules and payout curves are compile-time backend constants.
          They are shown here for operational reference but require a backend
          release to change. The three wager weights above are the complete
          live database-backed Keno configuration currently exposed to admins.
        </p>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={ShieldCheck} title="Accounting contract" />
        <div className="rounded-xl border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
          Every game stores the selected and drawn numbers, risk mode, hits,
          multiplier, bet, payout, and both ledger references in{" "}
          <code className="font-mono text-foreground">keno_games</code>.
          Stakes settle as{" "}
          <code className="font-mono text-foreground">keno_bet</code> and wins
          as <code className="font-mono text-foreground">keno_payout</code>.
          That makes wager, payout, GGR, RTP, user history, and provably-fair
          views fully reconcilable.
        </div>
      </section>
    </div>
  );
}
