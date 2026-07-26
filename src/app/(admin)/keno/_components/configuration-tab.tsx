import { Dices, Grid3X3, ShieldCheck, WalletCards } from "lucide-react";

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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <StatPanel title="Draw" icon={Grid3X3} accent="purple">
            <PanelRow label="Number grid" value="1–40" />
            <PanelRow label="Numbers drawn" value="10" />
            <PanelRow label="Player picks" value="1–10" />
          </StatPanel>
          <StatPanel title="Stake" icon={WalletCards} accent="amber">
            <PanelRow label="Minimum bet" value="$0.25" />
            <PanelRow label="Maximum bet" value="$1,000.00" />
            <PanelRow label="Settlement" value="Immediate" />
          </StatPanel>
          <StatPanel title="Risk" icon={ShieldCheck} accent="cyan">
            <PanelRow label="Low" value="Frequent returns" />
            <PanelRow label="Medium" value="Balanced curve" />
            <PanelRow label="High" value="Concentrated upside" />
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
