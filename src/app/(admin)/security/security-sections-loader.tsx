import {
  getCachedSiteConfig,
  getCachedVaultLockTimes,
  getCachedWagerRequirementDefaults,
  getCachedLeaderboardWagerWeights,
  getCachedRakebackWagerWeights,
  getCachedSourceWagerWeights,
  getCachedShardWagerWeights,
  getCachedShardConfig,
  getCachedMultiplierWagerWeights,
  getCachedRewardExpiry,
  getCachedCryptoFees,
} from "./_cached-reads";
import { SecurityPageSections } from "./security-page-sections";
import { RAIN_CONFIG_SITE_CONFIG_KEYS } from "../rain/config-keys";
import { WAGER_REQUIREMENT_SITE_CONFIG_KEYS } from "./wager-requirement-keys";
import { LEADERBOARD_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./leaderboard-wager-weights-keys";
import { RAKEBACK_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./rakeback-wager-weights-keys";
import { SOURCE_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./source-wager-weights-keys";
import { SHARD_WAGER_WEIGHT_SITE_CONFIG_KEYS } from "./shard-wager-weights-keys";
import { SHARD_CONFIG_SITE_CONFIG_KEYS } from "./shard-config-keys";
import { REWARD_EXPIRY_SITE_CONFIG_KEYS } from "./reward-expiry-keys";
import type { WagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";
import type { LeaderboardWagerWeights } from "@/lib/backend-api/leaderboard-wager-weights";
import type { RakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";
import type { SourceWagerWeights } from "@/lib/backend-api/source-wager-weights";
import type { ShardWagerWeights } from "@/lib/backend-api/shard-wager-weights";
import type { ShardConfig } from "@/lib/backend-api/shard-config";
import type { MultiplierWagerWeights } from "@/lib/backend-api/multiplier-wager-weights";
import type { RewardExpiry } from "@/lib/backend-api/reward-expiry";
import type { CryptoFees } from "@/lib/backend-api/crypto-fees";

/**
 * Async data loader for the /security sections. Lives behind a <Suspense>
 * boundary in `page.tsx` so the page shell (PageHero) paints immediately
 * while this fan-out resolves and streams in.
 *
 * All section reads are independent (one MAIN-DB site_config/vault scan +
 * nine backend-API GETs with no cross-dependency). They run together via
 * Promise.allSettled so they resolve in parallel AND each failure is
 * fault-isolated: a rejected leg falls back to the SAME value its old
 * per-await catch produced ([] for config, null for each card), so the
 * success path renders byte-identically. The reads are prod-cached (see
 * `_cached-reads.ts`), so warm loads and concurrent admins skip the slow
 * backend fan-out entirely. getSiteConfig still logs on failure to match
 * the previous behaviour.
 */
export async function SecuritySectionsLoader() {
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
    vaultLockTimesResult,
  ] = await Promise.allSettled([
    getCachedSiteConfig(),
    getCachedWagerRequirementDefaults(),
    getCachedLeaderboardWagerWeights(),
    getCachedRakebackWagerWeights(),
    getCachedSourceWagerWeights(),
    getCachedShardWagerWeights(),
    getCachedShardConfig(),
    getCachedMultiplierWagerWeights(),
    getCachedRewardExpiry(),
    getCachedCryptoFees(),
    getCachedVaultLockTimes(),
  ]);

  let allConfig: Awaited<ReturnType<typeof getCachedSiteConfig>> = [];
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

  const vaultLockTimes =
    vaultLockTimesResult.status === "fulfilled"
      ? vaultLockTimesResult.value
      : [];

  return (
    <SecurityPageSections
      config={config}
      rainConfigMoved={hasMovedKeys}
      vaultLockTimes={vaultLockTimes}
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
  );
}
