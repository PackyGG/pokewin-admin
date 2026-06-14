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

  let allConfig: Awaited<ReturnType<typeof getSiteConfig>> = [];
  try {
    allConfig = await getSiteConfig();
  } catch (err) {
    console.error("[security] getSiteConfig failed:", err);
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

  let wagerDefaults: WagerRequirementDefaults | null = null;
  try {
    wagerDefaults = await getWagerRequirementDefaults();
  } catch {
    wagerDefaults = null;
  }

  let leaderboardWeights: LeaderboardWagerWeights | null = null;
  try {
    leaderboardWeights = await getLeaderboardWagerWeights();
  } catch {
    leaderboardWeights = null;
  }

  let rakebackWeights: RakebackWagerWeights | null = null;
  try {
    rakebackWeights = await getRakebackWagerWeights();
  } catch {
    rakebackWeights = null;
  }

  let sourceWeights: SourceWagerWeights | null = null;
  try {
    sourceWeights = await getSourceWagerWeights();
  } catch {
    sourceWeights = null;
  }

  let shardWeights: ShardWagerWeights | null = null;
  try {
    shardWeights = await getShardWagerWeights();
  } catch {
    shardWeights = null;
  }

  let shardConfig: ShardConfig | null = null;
  try {
    shardConfig = await getShardConfig();
  } catch {
    shardConfig = null;
  }

  let multiplierWeights: MultiplierWagerWeights | null = null;
  try {
    multiplierWeights = await getMultiplierWagerWeights();
  } catch {
    multiplierWeights = null;
  }

  let rewardExpiry: RewardExpiry | null = null;
  try {
    rewardExpiry = await getRewardExpiry();
  } catch {
    rewardExpiry = null;
  }

  let cryptoFees: CryptoFees | null = null;
  try {
    cryptoFees = await getCryptoFees();
  } catch {
    cryptoFees = null;
  }

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
