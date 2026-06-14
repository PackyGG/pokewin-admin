import { Lock } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getSiteConfig } from "@/lib/queries/security";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SecurityPageSections } from "./security-page-sections";
import { RAIN_CONFIG_SITE_CONFIG_KEYS } from "../rain/config-keys";
import { WAGER_REQUIREMENT_SITE_CONFIG_KEYS } from "./wager-requirement-keys";
import { LEADERBOARD_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./leaderboard-wager-weights-keys";
import { RAKEBACK_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./rakeback-wager-weights-keys";
import { SOURCE_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./source-wager-weights-keys";
import { SHARD_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./shard-wager-weights-keys";
import { SHARD_CONFIG_SITE_CONFIG_KEYS } from "./shard-config-keys";
import { REWARD_EXPIRY_SITE_CONFIG_KEYS } from "./reward-expiry-keys";
import {
  getWagerRequirementDefaults,
  type WagerRequirementDefaults,
} from "@/lib/backend-api/wager-requirements";
import {
  getLeaderboardWagerWeights,
  type LeaderboardWagerWeights,
} from "@/lib/backend-api/leaderboard-wager-weights";
import {
  getRakebackWagerWeights,
  type RakebackWagerWeights,
} from "@/lib/backend-api/rakeback-wager-weights";
import {
  getSourceWagerWeights,
  type SourceWagerWeights,
} from "@/lib/backend-api/source-wager-weights";
import {
  getShardWagerWeights,
  type ShardWagerWeights,
} from "@/lib/backend-api/shard-wager-weights";
import {
  getShardConfig,
  type ShardConfig,
} from "@/lib/backend-api/shard-config";
import {
  getRewardExpiry,
  type RewardExpiry,
} from "@/lib/backend-api/reward-expiry";
import {
  getCryptoFees,
  type CryptoFees,
} from "@/lib/backend-api/crypto-fees";
import {
  getMultiplierWagerWeights,
  type MultiplierWagerWeights,
} from "@/lib/backend-api/multiplier-wager-weights";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requirePageAccess("/security");

  // All section reads are independent (one MAIN-DB site_config scan + 11
  // separate backend-API GETs with no cross-dependency). They USED to run
  // SERIALLY — one slow/failing backend read blocked or broke the whole
  // page (total latency = sum of all 12). Fire them together via
  // Promise.allSettled so they run in parallel AND each failure is
  // fault-isolated: a rejected leg falls back to the SAME value its old
  // per-await catch produced ([] for config, null for each card), so the
  // success path renders byte-identically to before. getSiteConfig still
  // logs on failure to match the previous behaviour.
  const [
    siteConfigResult,
    wagerDefaultsResult,
    leaderboardWeightsResult,
    rakebackWeightsResult,
    sourceWeightsResult,
    shardWeightsResult,
    shardConfigResult,
    multiplierWeightsResult,
    rewardExpiryResult,
    cryptoFeesResult,
  ] = await Promise.allSettled([
    getSiteConfig(),
    getWagerRequirementDefaults(),
    getLeaderboardWagerWeights(),
    getRakebackWagerWeights(),
    getSourceWagerWeights(),
    getShardWagerWeights(),
    getShardConfig(),
    getMultiplierWagerWeights(),
    getRewardExpiry(),
    getCryptoFees(),
  ]);

  let allConfig: Awaited<ReturnType<typeof getSiteConfig>> = [];
  if (siteConfigResult.status === "fulfilled") {
    allConfig = siteConfigResult.value;
  } else {
    console.error("[security] getSiteConfig failed:", siteConfigResult.reason);
  }

  const movedKeys = new Set<string>([
    ...RAIN_CONFIG_SITE_CONFIG_KEYS,
    ...WAGER_REQUIREMENT_SITE_CONFIG_KEYS,
    ...LEADERBOARD_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...RAKEBACK_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...SOURCE_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...SHARD_WAGER_WEIGHT_SITE_CONFIG_KEYS,
    ...SHARD_CONFIG_SITE_CONFIG_KEYS,
    ...REWARD_EXPIRY_SITE_CONFIG_KEYS,
  ]);
  const config = allConfig.filter((row) => !movedKeys.has(row.key));
  const hasMovedKeys = allConfig.some((row) =>
    RAIN_CONFIG_SITE_CONFIG_KEYS.includes(row.key),
  );

  const wagerDefaults: WagerRequirementDefaults | null =
    wagerDefaultsResult.status === "fulfilled"
      ? wagerDefaultsResult.value
      : null;

  const leaderboardWeights: LeaderboardWagerWeights | null =
    leaderboardWeightsResult.status === "fulfilled"
      ? leaderboardWeightsResult.value
      : null;

  const rakebackWeights: RakebackWagerWeights | null =
    rakebackWeightsResult.status === "fulfilled"
      ? rakebackWeightsResult.value
      : null;

  const sourceWeights: SourceWagerWeights | null =
    sourceWeightsResult.status === "fulfilled"
      ? sourceWeightsResult.value
      : null;

  const shardWeights: ShardWagerWeights | null =
    shardWeightsResult.status === "fulfilled" ? shardWeightsResult.value : null;

  const shardConfig: ShardConfig | null =
    shardConfigResult.status === "fulfilled" ? shardConfigResult.value : null;

  const multiplierWeights: MultiplierWagerWeights | null =
    multiplierWeightsResult.status === "fulfilled"
      ? multiplierWeightsResult.value
      : null;

  const rewardExpiry: RewardExpiry | null =
    rewardExpiryResult.status === "fulfilled" ? rewardExpiryResult.value : null;

  const cryptoFees: CryptoFees | null =
    cryptoFeesResult.status === "fulfilled" ? cryptoFeesResult.value : null;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Lock}
          title="Security"
          subtitle="Country restrictions, brute-force protection, and platform lockdown controls."
        />
      </PageHero>

      <FadeIn>
        <SecurityPageSections
          config={config}
          rainConfigMoved={hasMovedKeys}
          wagerDefaults={wagerDefaults}
          leaderboardWeights={leaderboardWeights}
          rakebackWeights={rakebackWeights}
          shardConfig={shardConfig}
          shardWeights={shardWeights}
          sourceWeights={sourceWeights}
          multiplierWeights={multiplierWeights}
          rewardExpiry={rewardExpiry}
          cryptoFees={cryptoFees}
        />
      </FadeIn>
    </div>
  );
}
