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
import { getCachedKenoConfig } from "../_cached-reads";
import {
  getKenoRtp,
  KENO_DRAW_COUNT,
  KENO_GRID_SIZE,
  KENO_DEFAULT_MAX_BET_USD,
  KENO_DEFAULT_MAX_WIN_USD,
  KENO_MAX_CONFIGURABLE_BET_USD,
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
  const kenoConfig = await getCachedKenoConfig().catch(() => null);
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
          title="System configuration"
          action={
            <Badge variant="outline" className="font-normal">
              2 live settings · {canEdit ? "Editing enabled" : "Read only"}
            </Badge>
          }
        />
        <KenoSettingsCard
          kenoConfig={kenoConfig}
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
              label="Current maximum"
              value={
                kenoConfig
                  ? `$${kenoConfig.max_bet_usd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                  : "Unavailable"
              }
            />
            <PanelRow
              label="Maximum win"
              value={
                kenoConfig
                  ? `$${kenoConfig.max_win_usd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                  : "Unavailable"
              }
            />
            <PanelRow
              label="Bet default / allowed cap"
              value={`$${KENO_DEFAULT_MAX_BET_USD.toFixed(2)} / $${KENO_MAX_CONFIGURABLE_BET_USD.toLocaleString("en-US")}`}
            />
            <PanelRow
              label="Win default"
              value={`$${KENO_DEFAULT_MAX_WIN_USD.toLocaleString("en-US")}`}
            />
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
          The grid, draws, picks, minimum bet, risk modes, and payout curves
          are compile-time backend constants. The maximum bet and maximum win
          above are database-backed and change through the backend admin API.
          The win cap limits the final payout after the selected multiplier is
          applied.
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
