import "server-only";

import { z } from "zod";
import type { DbEnv } from "@/lib/db-env";

export const eosUserRuleSchema = z.object({
  target: z.enum(["loss", "win", "any"]),
  strategy: z.enum([
    "random",
    "lowest_profit",
    "highest_profit",
    "lowest_multiplier",
    "highest_multiplier",
  ]),
  count: z.number().int().min(1).max(100),
  minMultiplier: z.number().min(0).max(10_000).nullable().default(null),
  maxMultiplier: z.number().min(0).max(10_000).nullable().default(null),
}).refine((rule) => rule.minMultiplier === null
  || rule.maxMultiplier === null
  || rule.minMultiplier <= rule.maxMultiplier);

const configSchema = z.object({
  // Default keeps the admin deploy compatible with an older monitor during a
  // staggered rollout. The hardened monitor always returns this explicitly.
  environment: z.enum(["dev", "prod"]).default("dev"),
  userOnlyLoses: z.boolean(),
  rules: z.array(eosUserRuleSchema).default([
    {
      target: "any",
      strategy: "random",
      count: 1,
      minMultiplier: null,
      maxMultiplier: null,
    },
  ]),
  currentRuleIndex: z.number().int().nonnegative().default(0),
  remainingInRule: z.number().int().nonnegative().default(1),
  persistent: z.boolean().default(true),
  randomized: z.boolean().default(false),
  enabled: z.boolean().default(false),
  forceAllLosses: z.boolean().default(false),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const userConfigSchema = z.object({
  environment: z.enum(["dev", "prod"]).default("dev"),
  userId: z.string().min(1).max(100),
  username: z.string().nullable(),
  rules: z.array(eosUserRuleSchema),
  currentRuleIndex: z.number().int().nonnegative(),
  remainingInRule: z.number().int().nonnegative(),
  persistent: z.boolean().default(false),
  randomized: z.boolean().default(false),
  enabled: z.boolean(),
  forceLosses: z.boolean().default(false),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const userSelectionCandidateSchema = z.object({
  blockNumber: z.number().int().positive(),
  winningTeam: z.number().int(),
  creatorTeam: z.number().int(),
  creatorWonBattle: z.boolean(),
  creatorCost: z.number(),
  creatorProfitLoss: z.number(),
  creatorMultiplier: z.number().nullable(),
});

const userSelectionSchema = z.object({
  battleId: z.string().uuid(),
  createdAt: z.string(),
  selectedAt: z.string(),
  version: z.literal(1),
  source: z.enum(["user", "global", "random"]),
  controlKind: z.enum([
    "user_rule",
    "global_rule",
    "user_force_losses",
    "global_force_losses",
    "legacy_global_losses",
    "random",
  ]),
  randomBlockNumber: z.number().int().positive(),
  battleMode: z.string().max(50),
  crazyMode: z.boolean(),
  currency: z.string().max(50),
  requestedTarget: z.enum(["loss", "win", "any"]).nullable(),
  requestedStrategy: z.enum([
    "random",
    "lowest_profit",
    "highest_profit",
    "lowest_multiplier",
    "highest_multiplier",
  ]).nullable(),
  requestedMinMultiplier: z.number().nullable(),
  requestedMaxMultiplier: z.number().nullable(),
  fallbackReason: z.enum(["target_unavailable", "range_unavailable"]).nullable(),
  selected: userSelectionCandidateSchema,
  candidates: z.array(userSelectionCandidateSchema).length(5),
});

const overviewPeriodSchema = z.object({
  period: z.enum(["24h", "7d", "30d"]),
  currency: z.enum(["real", "coin"]),
  battleCount: z.number().int().nonnegative(),
  steeredBattles: z.number().int().nonnegative(),
  matchedBattles: z.number().int().nonnegative(),
  fallbackBattles: z.number().int().nonnegative(),
  targetUnavailableBattles: z.number().int().nonnegative(),
  rangeUnavailableBattles: z.number().int().nonnegative(),
  forceLossBattles: z.number().int().nonnegative(),
  creatorWinsAvoided: z.number().int().nonnegative(),
  selectedWins: z.number().int().nonnegative(),
  selectedLosses: z.number().int().nonnegative(),
  selectedCreatorProfitLoss: z.number(),
  randomBaselineCreatorProfitLoss: z.number(),
  estimatedCreatorProfitReduction: z.number(),
});

const overviewSchema = z.object({
  environment: z.enum(["dev", "prod"]),
  generatedAt: z.string(),
  trackingStartedAt: z.string().nullable(),
  periods: z.array(overviewPeriodSchema),
});

export type EosTestConfig = z.infer<typeof configSchema>;
export type EosUserRule = z.infer<typeof eosUserRuleSchema>;
export type EosUserConfig = z.infer<typeof userConfigSchema>;
export type EosUserSelection = z.infer<typeof userSelectionSchema>;
export type EosTestOverview = z.infer<typeof overviewSchema>;
export type EosTestOverviewPeriod = z.infer<typeof overviewPeriodSchema>;

const TIMEOUT_MS = 5_000;
const PATH = "/v1/testing/eos-random-block/config";
const USERS_PATH = `${PATH}/users`;
const OVERVIEW_PATH = `${PATH}/overview`;
const ENVIRONMENT_HEADER = "x-pokewin-environment";

function connection(): { baseUrl: string; token: string } {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("The EOS test configuration service is not configured.");
  }
  return { baseUrl, token };
}

function serviceError(response: Response, subject: "global" | "user" | "overview"): Error {
  if (response.status === 401 || response.status === 403) {
    return new Error("The EOS control credentials were rejected.");
  }
  if (response.status === 409) {
    return new Error("The EOS flow changed while it was being saved. Reload and try again.");
  }
  if (response.status === 429) {
    return new Error("Too many EOS control updates. Wait a moment and try again.");
  }
  if (response.status >= 500) {
    return new Error("The EOS control service is temporarily unavailable.");
  }
  if (subject === "global") {
    return new Error("The EOS global flow could not be loaded or saved.");
  }
  return new Error(subject === "user"
    ? "The EOS user flow could not be loaded or saved."
    : "The EOS control overview could not be loaded.");
}

async function request(
  environment: DbEnv,
  init?: RequestInit,
  path = PATH,
): Promise<EosTestConfig> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        [ENVIRONMENT_HEADER]: environment,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The EOS test configuration service did not respond.");
  }
  if (!response.ok) {
    throw serviceError(response, "global");
  }
  try {
    const data = z.object({ data: configSchema }).parse(await response.json()).data;
    if (data.environment !== environment) {
      throw new Error("The EOS control service returned the wrong environment.");
    }
    return data;
  } catch {
    throw new Error("The EOS control service returned an invalid response.");
  }
}

export function getEosTestConfig(environment: DbEnv): Promise<EosTestConfig> {
  return request(environment);
}

export function updateEosTestConfig(environment: DbEnv, input: {
  rules: EosUserRule[];
  persistent: boolean;
  randomized: boolean;
  enabled: boolean;
  forceAllLosses: boolean;
  actor: string;
}): Promise<EosTestConfig> {
  return request(environment, { method: "PUT", body: JSON.stringify(input) });
}

export function updateEosTestEnabled(environment: DbEnv, input: {
  enabled: boolean;
  actor: string;
}): Promise<EosTestConfig> {
  return request(environment, {
    method: "PATCH",
    body: JSON.stringify(input),
  }, `${PATH}/enabled`);
}

async function userRequest<T>(
  environment: DbEnv,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        [ENVIRONMENT_HEADER]: environment,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The EOS user configuration service did not respond.");
  }
  if (!response.ok) {
    throw serviceError(response, "user");
  }
  try {
    return schema.parse(await response.json());
  } catch {
    throw new Error("The EOS user flow service returned an invalid response.");
  }
}

export async function getEosTestOverview(
  environment: DbEnv,
): Promise<EosTestOverview> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${OVERVIEW_PATH}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        [ENVIRONMENT_HEADER]: environment,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The EOS control overview service did not respond.");
  }
  if (!response.ok) {
    throw serviceError(response, "overview");
  }
  try {
    const data = z.object({ data: overviewSchema }).parse(await response.json()).data;
    if (data.environment !== environment) {
      throw new Error("The EOS control overview returned the wrong environment.");
    }
    return data;
  } catch {
    throw new Error("The EOS control overview service returned an invalid response.");
  }
}

export async function listEosUserConfigs(environment: DbEnv): Promise<EosUserConfig[]> {
  const result = await userRequest(
    environment,
    USERS_PATH,
    z.object({ data: z.array(userConfigSchema) }),
  );
  if (result.data.some((entry) => entry.environment !== environment)) {
    throw new Error("The EOS user flow service returned the wrong environment.");
  }
  return result.data;
}

export async function updateEosUserConfig(environment: DbEnv, input: {
  userId: string;
  username: string | null;
  rules: EosUserRule[];
  persistent: boolean;
  randomized: boolean;
  enabled: boolean;
  forceLosses?: boolean;
  actor: string;
}): Promise<EosUserConfig> {
  const result = await userRequest(
    environment,
    `${USERS_PATH}/${encodeURIComponent(input.userId)}`,
    z.object({ data: userConfigSchema }),
    {
      method: "PUT",
      body: JSON.stringify({
        username: input.username,
        rules: input.rules,
        persistent: input.persistent,
        randomized: input.randomized,
        enabled: input.enabled,
        ...(input.forceLosses === undefined
          ? {}
          : { forceLosses: input.forceLosses }),
        actor: input.actor,
      }),
    },
  );
  if (result.data.environment !== environment) {
    throw new Error("The EOS user flow service returned the wrong environment.");
  }
  return result.data;
}

export async function updateEosUserForceLosses(environment: DbEnv, input: {
  userId: string;
  forceLosses: boolean;
  actor: string;
}): Promise<EosUserConfig> {
  const result = await userRequest(
    environment,
    `${USERS_PATH}/${encodeURIComponent(input.userId)}/force-losses`,
    z.object({ data: userConfigSchema }),
    {
      method: "PATCH",
      body: JSON.stringify({
        forceLosses: input.forceLosses,
        actor: input.actor,
      }),
    },
  );
  if (result.data.environment !== environment) {
    throw new Error("The EOS user flow service returned the wrong environment.");
  }
  return result.data;
}

export async function updateEosUserEnabled(environment: DbEnv, input: {
  userId: string;
  enabled: boolean;
  actor: string;
}): Promise<EosUserConfig> {
  const result = await userRequest(
    environment,
    `${USERS_PATH}/${encodeURIComponent(input.userId)}/enabled`,
    z.object({ data: userConfigSchema }),
    {
      method: "PATCH",
      body: JSON.stringify({
        enabled: input.enabled,
        actor: input.actor,
      }),
    },
  );
  if (result.data.environment !== environment) {
    throw new Error("The EOS user flow service returned the wrong environment.");
  }
  return result.data;
}

export async function listEosUserSelections(
  environment: DbEnv,
  userId: string,
  limit = 20,
): Promise<EosUserSelection[]> {
  const result = await userRequest(
    environment,
    `${USERS_PATH}/${encodeURIComponent(userId)}/selections?limit=${limit}`,
    z.object({
      environment: z.enum(["dev", "prod"]),
      data: z.array(userSelectionSchema),
    }),
  );
  if (result.environment !== environment) {
    throw new Error("The EOS user history service returned the wrong environment.");
  }
  return result.data;
}

export async function deleteEosUserConfig(
  environment: DbEnv,
  userId: string,
): Promise<void> {
  const { baseUrl, token } = connection();
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}${USERS_PATH}/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          [ENVIRONMENT_HEADER]: environment,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("The EOS user configuration service did not respond.");
  }
  if (!response.ok) {
    throw serviceError(response, "user");
  }
}
