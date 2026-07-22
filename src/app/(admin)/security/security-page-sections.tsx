"use client";

import { CollapsibleSecuritySection } from "./collapsible-security-section";
import { SecurityContent } from "./security-content";
import { WagerRequirementCard } from "./wager-requirement-card";
import { LeaderboardWagerWeightsCard } from "./leaderboard-wager-weights-card";
import { RakebackWagerWeightsCard } from "./rakeback-wager-weights-card";
import { ShardConfigCard } from "./shard-config-card";
import { ShardWagerWeightsCard } from "./shard-wager-weights-card";
import { SourceWagerWeightsCard } from "./source-wager-weights-card";
import { MultiplierWagerWeightsCard } from "./multiplier-wager-weights-card";
import { RewardExpiryCard } from "./reward-expiry-card";
import { CryptoFeesCard } from "./crypto-fees-card";
import { DepositBonusConfigCard } from "./deposit-bonus-config-card";
import { VaultLockCard, type VaultLockTime } from "./vault-lock-card";
import { KenoSettingsCard } from "./keno-settings-card";
import type { SiteConfigRow } from "@/lib/queries/security";
import type { WagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";
import type { LeaderboardWagerWeights } from "@/lib/backend-api/leaderboard-wager-weights";
import type { RakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";
import type { SourceWagerWeights } from "@/lib/backend-api/source-wager-weights";
import type { ShardWagerWeights } from "@/lib/backend-api/shard-wager-weights";
import type { ShardConfig } from "@/lib/backend-api/shard-config";
import type { MultiplierWagerWeights } from "@/lib/backend-api/multiplier-wager-weights";
import type { RewardExpiry } from "@/lib/backend-api/reward-expiry";
import type { CryptoFees } from "@/lib/backend-api/crypto-fees";
import type { DepositBonusConfig } from "@/lib/backend-api/deposit-bonus-config";

/**
 * Single client boundary for all /security panels. The server page fetches
 * data and passes plain serializable props — no client-in-client slots from
 * the RSC tree (avoids production render failures).
 */
export function SecurityPageSections({
  config,
  rainConfigMoved,
  vaultLockTimes,
  wagerDefaults,
  leaderboardWeights,
  rakebackWeights,
  shardConfig,
  shardWeights,
  sourceWeights,
  multiplierWeights,
  rewardExpiry,
  cryptoFees,
  depositBonusConfig,
}: {
  config: SiteConfigRow[];
  rainConfigMoved: boolean;
  vaultLockTimes: VaultLockTime[];
  wagerDefaults: WagerRequirementDefaults | null;
  leaderboardWeights: LeaderboardWagerWeights | null;
  rakebackWeights: RakebackWagerWeights | null;
  shardConfig: ShardConfig | null;
  shardWeights: ShardWagerWeights | null;
  sourceWeights: SourceWagerWeights | null;
  multiplierWeights: MultiplierWagerWeights | null;
  rewardExpiry: RewardExpiry | null;
  cryptoFees: CryptoFees | null;
  depositBonusConfig: DepositBonusConfig | null;
}) {
  return (
    <div className="space-y-6">
      <CollapsibleSecuritySection icon="timer" title="Vault Lock Times">
        <VaultLockCard vaultLockTimes={vaultLockTimes} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="banknote" title="Withdrawal Wager Requirements">
        <WagerRequirementCard initial={wagerDefaults} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="trophy" title="Leaderboard Wager Weights">
        <LeaderboardWagerWeightsCard initial={leaderboardWeights} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="percent" title="Rakeback Wager Weights">
        <RakebackWagerWeightsCard initial={rakebackWeights} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="sparkles" title="Shard Earn Rate">
        <ShardConfigCard initial={shardConfig} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="gem" title="Shard Wager Weights">
        <ShardWagerWeightsCard initial={shardWeights} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="coins" title="Funding-Source Wager Weights">
        <SourceWagerWeightsCard initial={sourceWeights} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="gauge" title="Multiplier Wager Weights">
        <MultiplierWagerWeightsCard initial={multiplierWeights} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="hourglass" title="Reward Expiry">
        <RewardExpiryCard initial={rewardExpiry} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="bitcoin" title="Crypto Exchange-Rate Fees">
        <CryptoFeesCard initial={cryptoFees} />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="gift" title="Deposit Bonus Cap">
        <DepositBonusConfigCard initial={depositBonusConfig} />
      </CollapsibleSecuritySection>

      {/* Per-GAME view, deliberately last of the real sections: the cards
          above are grouped by destination, this one gathers everything keno
          in one place. Only the raw Site Configuration fallback sits below. */}
      <CollapsibleSecuritySection icon="dices" title="Keno">
        <KenoSettingsCard
          wagerDefaults={wagerDefaults}
          leaderboardWeights={leaderboardWeights}
          rakebackWeights={rakebackWeights}
        />
      </CollapsibleSecuritySection>

      <CollapsibleSecuritySection icon="sliders" title="Site Configuration">
        <SecurityContent config={config} rainConfigMoved={rainConfigMoved} />
      </CollapsibleSecuritySection>
    </div>
  );
}
