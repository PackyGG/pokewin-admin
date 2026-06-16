import "server-only";

import { unstable_cache } from "next/cache";
import { readDbEnv } from "@/lib/db-env";
import { getSiteConfig, getVaultLockTimes } from "@/lib/queries/security";
import { getWagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";
import { getLeaderboardWagerWeights } from "@/lib/backend-api/leaderboard-wager-weights";
import { getRakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";
import { getSourceWagerWeights } from "@/lib/backend-api/source-wager-weights";
import { getShardWagerWeights } from "@/lib/backend-api/shard-wager-weights";
import { getShardConfig } from "@/lib/backend-api/shard-config";
import { getMultiplierWagerWeights } from "@/lib/backend-api/multiplier-wager-weights";
import { getRewardExpiry } from "@/lib/backend-api/reward-expiry";
import { getCryptoFees } from "@/lib/backend-api/crypto-fees";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";

/**
 * Cross-request cache for the /security page's section reads.
 *
 * The page fans out one MAIN-DB `site_config`/`vault_lock_times` scan plus
 * nine independent backend-API GETs. On prod ClickHouse is dormant, so every
 * one of those GETs is served by Postgres through the game backend with the
 * client's default 8s timeout + transient-retry budget — and NONE of them was
 * cached, so EVERY page load re-paid the full fan-out latency (bounded by the
 * slowest leg). These knobs change rarely (an admin editing a config value),
 * so memoizing the reads makes repeat loads and concurrent admins resolve from
 * one warmed entry instead of re-walking the backend each time.
 *
 * Correctness:
 *   • PROD-ONLY cache — same pattern as `users-detail-cache.ts`. The
 *     underlying reads resolve the per-admin `admin_db_env` cookie
 *     (`getDb()` / `resolveBackendApiConfig()`); `unstable_cache` runs its
 *     callback OUTSIDE the request's dynamic scope, where that cookie read
 *     falls back to "prod". So we cache ONLY when the request is on prod and
 *     bypass to the live read for a dev-toggled admin, who then always sees
 *     live dev data.
 *   • FAULT ISOLATION preserved — `unstable_cache` never caches a rejected
 *     promise, so a failing backend leg still rejects and the page's
 *     `Promise.allSettled` falls back to the same value as before ([] for
 *     site_config, null per card).
 *   • FRESH-ON-EDIT — every section's server action calls
 *     `revalidateTag(SECURITY_CACHE_TAG)`, so an admin edit busts the cached
 *     value immediately rather than waiting out the revalidate window.
 */

// Config rarely changes and the explicit revalidateTag busts on every edit, so
// a long window just minimizes how often a cold load re-pays the slow fan-out.
const REVALIDATE_SECONDS = 300;

const cachedSiteConfig = unstable_cache(
  () => getSiteConfig(),
  ["security-site-config-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedVaultLockTimes = unstable_cache(
  () => getVaultLockTimes(),
  ["security-vault-lock-times-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedWagerRequirementDefaults = unstable_cache(
  () => getWagerRequirementDefaults(),
  ["security-wager-requirement-defaults-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedLeaderboardWagerWeights = unstable_cache(
  () => getLeaderboardWagerWeights(),
  ["security-leaderboard-wager-weights-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedRakebackWagerWeights = unstable_cache(
  () => getRakebackWagerWeights(),
  ["security-rakeback-wager-weights-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedSourceWagerWeights = unstable_cache(
  () => getSourceWagerWeights(),
  ["security-source-wager-weights-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedShardWagerWeights = unstable_cache(
  () => getShardWagerWeights(),
  ["security-shard-wager-weights-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedShardConfig = unstable_cache(
  () => getShardConfig(),
  ["security-shard-config-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedMultiplierWagerWeights = unstable_cache(
  () => getMultiplierWagerWeights(),
  ["security-multiplier-wager-weights-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedRewardExpiry = unstable_cache(
  () => getRewardExpiry(),
  ["security-reward-expiry-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

const cachedCryptoFees = unstable_cache(
  () => getCryptoFees(),
  ["security-crypto-fees-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: [SECURITY_CACHE_TAG] },
);

/**
 * Prod-cached / dev-direct read for each /security section. On a dev-toggled
 * admin every helper bypasses the cache and runs the live read so they always
 * see live dev data (see module doc).
 */
export async function getCachedSiteConfig(): ReturnType<typeof getSiteConfig> {
  const env = await readDbEnv();
  return env === "prod" ? cachedSiteConfig() : getSiteConfig();
}

export async function getCachedVaultLockTimes(): ReturnType<
  typeof getVaultLockTimes
> {
  const env = await readDbEnv();
  return env === "prod" ? cachedVaultLockTimes() : getVaultLockTimes();
}

export async function getCachedWagerRequirementDefaults(): ReturnType<
  typeof getWagerRequirementDefaults
> {
  const env = await readDbEnv();
  return env === "prod"
    ? cachedWagerRequirementDefaults()
    : getWagerRequirementDefaults();
}

export async function getCachedLeaderboardWagerWeights(): ReturnType<
  typeof getLeaderboardWagerWeights
> {
  const env = await readDbEnv();
  return env === "prod"
    ? cachedLeaderboardWagerWeights()
    : getLeaderboardWagerWeights();
}

export async function getCachedRakebackWagerWeights(): ReturnType<
  typeof getRakebackWagerWeights
> {
  const env = await readDbEnv();
  return env === "prod"
    ? cachedRakebackWagerWeights()
    : getRakebackWagerWeights();
}

export async function getCachedSourceWagerWeights(): ReturnType<
  typeof getSourceWagerWeights
> {
  const env = await readDbEnv();
  return env === "prod" ? cachedSourceWagerWeights() : getSourceWagerWeights();
}

export async function getCachedShardWagerWeights(): ReturnType<
  typeof getShardWagerWeights
> {
  const env = await readDbEnv();
  return env === "prod" ? cachedShardWagerWeights() : getShardWagerWeights();
}

export async function getCachedShardConfig(): ReturnType<typeof getShardConfig> {
  const env = await readDbEnv();
  return env === "prod" ? cachedShardConfig() : getShardConfig();
}

export async function getCachedMultiplierWagerWeights(): ReturnType<
  typeof getMultiplierWagerWeights
> {
  const env = await readDbEnv();
  return env === "prod"
    ? cachedMultiplierWagerWeights()
    : getMultiplierWagerWeights();
}

export async function getCachedRewardExpiry(): ReturnType<
  typeof getRewardExpiry
> {
  const env = await readDbEnv();
  return env === "prod" ? cachedRewardExpiry() : getRewardExpiry();
}

export async function getCachedCryptoFees(): ReturnType<typeof getCryptoFees> {
  const env = await readDbEnv();
  return env === "prod" ? cachedCryptoFees() : getCryptoFees();
}
