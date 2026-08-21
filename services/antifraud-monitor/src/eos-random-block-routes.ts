import { randomInt } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import {
  BattleSimulationError,
  type BattleCandidateOutcome,
  type BattleOutcomeSource,
} from "./battle-outcome-simulator.js";
import type {
  BattleTestConfigSource,
  BattleTestEnvironment,
  BattleTestSelectionAuditInput,
  BattleTestUserInstruction,
} from "./battle-test-config.js";

export const EOS_RANDOM_BLOCK_PATH = "/v1/testing/eos-random-block";
export const EOS_RANDOM_BLOCK_CONFIG_PATH = `${EOS_RANDOM_BLOCK_PATH}/config`;
export const EOS_RANDOM_BLOCK_USER_CONFIG_PATH =
  `${EOS_RANDOM_BLOCK_CONFIG_PATH}/users`;
export const EOS_CHAIN_INFO_PATH = "/v1/chain/get_info";
export const EOS_CHAIN_BLOCK_PATH = "/v1/chain/get_block";
export const EOS_ENVIRONMENT_HEADER = "x-pokewin-environment";

export type EosBattleEnvironmentResources = {
  battleOutcomes?: BattleOutcomeSource;
  testConfig?: BattleTestConfigSource;
};

export type EosBattleEnvironmentRouting = Partial<
  Record<BattleTestEnvironment, EosBattleEnvironmentResources>
>;

const EOS_ENDPOINTS = [
  "https://mainnet.genereos.io",
  "https://api.eostitan.com",
  "https://eos.newdex.one",
  "https://api.eossupport.io",
  "https://mainnet.eosamsterdam.net",
] as const;

const BLOCK_COUNT = 5;
const PROVIDER_TIMEOUT_MS = 3_000;
const BLOCK_ID_PATTERN = /^[a-f0-9]{64}$/i;

export type EosBlockCandidate = {
  blockNumber: number;
  blockHash: string;
  blockTimestamp: string;
};

export type EosRandomBlockSelection = {
  provider: string;
  chainInfo: Record<string, unknown>;
  selectedIndex: number;
  selectedBlock: EosBlockCandidate;
  candidates: EosBlockCandidate[];
};

export interface EosRandomBlockSource {
  select(): Promise<EosRandomBlockSelection>;
  getBlock?(blockNumOrId: number | string): Promise<Record<string, unknown>>;
}

type Fetcher = typeof fetch;
type RandomIndex = (upperExclusive: number) => number;

const requestSchema = z.object({
  userID: z.string().trim().min(1).max(100),
  battleID: z.uuid().optional(),
}).strict();

const userRuleSchema = z.object({
  target: z.enum(["loss", "win", "any"]),
  strategy: z.enum([
    "random", "lowest_profit", "highest_profit",
    "lowest_multiplier", "highest_multiplier",
  ]),
  count: z.number().int().min(1).max(100),
  minMultiplier: z.number().min(0).max(10_000).nullable().default(null),
  maxMultiplier: z.number().min(0).max(10_000).nullable().default(null),
}).strict().refine((rule) => rule.minMultiplier === null
  || rule.maxMultiplier === null
  || rule.minMultiplier <= rule.maxMultiplier);

const flowUpdateSchema = z.object({
  rules: z.array(userRuleSchema).min(1).max(20),
  persistent: z.boolean(),
  randomized: z.boolean(),
  enabled: z.boolean(),
  forceAllLosses: z.boolean().default(false),
  actor: z.string().trim().min(1).max(120),
}).strict().refine((flow) => !flow.randomized || flow.persistent);

const configUpdateSchema = z.object({
  userOnlyLoses: z.boolean(),
  actor: z.string().trim().min(1).max(120),
}).strict();

const userConfigUpdateSchema = z.object({
  username: z.string().trim().min(1).max(100).nullable(),
  rules: z.array(userRuleSchema).min(1).max(20),
  persistent: z.boolean().default(false),
  randomized: z.boolean().default(false),
  enabled: z.boolean(),
  forceLosses: z.boolean().optional(),
  actor: z.string().trim().min(1).max(120),
}).strict().refine((flow) => !flow.randomized || flow.persistent);

const userForceLossesUpdateSchema = z.object({
  forceLosses: z.boolean(),
  actor: z.string().trim().min(1).max(120),
}).strict();

const userSelectionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

const chainBlockRequestSchema = z.object({
  block_num_or_id: z.union([
    z.number().int().positive(),
    z.string().trim().min(1).max(100),
  ]),
}).strict();

export function selectBattleTestOutcome(
  outcomes: BattleCandidateOutcome[],
  randomBlockNumber: number,
  userOnlyLoses: boolean,
  randomIndex: RandomIndex = randomInt,
): BattleCandidateOutcome {
  if (outcomes.length === 0) {
    throw new BattleSimulationError("battle_data_incomplete", 409);
  }
  if (!userOnlyLoses) {
    return outcomes.find((outcome) => outcome.blockNumber === randomBlockNumber)
      ?? outcomes[0]!;
  }
  const losses = outcomes.filter((outcome) => !outcome.creatorWonBattle);
  if (losses.length > 0) return losses[randomIndex(losses.length)]!;
  return outcomes.reduce((lowest, outcome) =>
    outcome.creatorProfitLoss < lowest.creatorProfitLoss ? outcome : lowest
  );
}

export function selectBattleTestInstructionOutcome(
  outcomes: BattleCandidateOutcome[],
  randomBlockNumber: number,
  instruction: BattleTestUserInstruction,
  randomIndex: RandomIndex = randomInt,
): BattleCandidateOutcome {
  if (outcomes.length === 0) {
    throw new BattleSimulationError("battle_data_incomplete", 409);
  }
  const targetMatches = instruction.target === "any"
    ? outcomes
    : outcomes.filter((outcome) =>
      instruction.target === "win"
        ? outcome.creatorWonBattle
        : !outcome.creatorWonBattle
    );

  if (targetMatches.length === 0) {
    return outcomes.reduce((best, outcome) => {
      if (instruction.target === "win") {
        return outcome.creatorProfitLoss > best.creatorProfitLoss
          ? outcome
          : best;
      }
      return outcome.creatorProfitLoss < best.creatorProfitLoss
        ? outcome
        : best;
    });
  }
  const matching = targetMatches.filter((outcome) =>
    (instruction.minMultiplier === null
      || instruction.minMultiplier === undefined
      || outcomeMultiplier(outcome) >= instruction.minMultiplier)
    && (instruction.maxMultiplier === null
      || instruction.maxMultiplier === undefined
      || outcomeMultiplier(outcome) <= instruction.maxMultiplier)
  );
  // Outcome intent is stronger than the optional range. If the five-block
  // window contains the requested win/loss but none inside the range, retain
  // the requested outcome instead of silently crossing to the opposite side.
  const eligible = matching.length > 0 ? matching : targetMatches;
  if (instruction.strategy === "lowest_profit") {
    return eligible.reduce((lowest, outcome) =>
      outcome.creatorProfitLoss < lowest.creatorProfitLoss ? outcome : lowest
    );
  }
  if (instruction.strategy === "highest_profit") {
    return eligible.reduce((highest, outcome) =>
      outcome.creatorProfitLoss > highest.creatorProfitLoss ? outcome : highest
    );
  }
  if (instruction.strategy === "lowest_multiplier") {
    return eligible.reduce((lowest, outcome) =>
      outcomeMultiplier(outcome) < outcomeMultiplier(lowest) ? outcome : lowest
    );
  }
  if (instruction.strategy === "highest_multiplier") {
    return eligible.reduce((highest, outcome) =>
      outcomeMultiplier(outcome) > outcomeMultiplier(highest) ? outcome : highest
    );
  }
  return eligible.find((outcome) => outcome.blockNumber === randomBlockNumber)
    ?? eligible[randomIndex(eligible.length)]!;
}

function outcomeMultiplier(outcome: BattleCandidateOutcome): number {
  return outcome.creatorMultiplier
    ?? (outcome.creatorCost > 0
      ? (outcome.creatorProfitLoss + outcome.creatorCost) / outcome.creatorCost
      : 0);
}

function selectionAudit(
  outcomes: BattleCandidateOutcome[],
  selected: BattleCandidateOutcome,
  instruction: BattleTestUserInstruction | null,
  userOnlyLoses: boolean,
  randomBlockNumber: number,
  battle: { mode: string; crazyMode: boolean; currency: string },
): BattleTestSelectionAuditInput {
  const requestedTarget = instruction?.target ?? (userOnlyLoses ? "loss" : null);
  const requestedStrategy = instruction?.strategy ?? (userOnlyLoses ? "random" : null);
  const targetMatches = requestedTarget === null || requestedTarget === "any"
    ? outcomes
    : outcomes.filter((outcome) => requestedTarget === "win"
      ? outcome.creatorWonBattle
      : !outcome.creatorWonBattle);
  const hasRange = instruction
    && (instruction.minMultiplier !== null && instruction.minMultiplier !== undefined
      || instruction.maxMultiplier !== null && instruction.maxMultiplier !== undefined);
  const rangeMatches = hasRange
    ? targetMatches.filter((outcome) =>
        (instruction.minMultiplier === null
          || instruction.minMultiplier === undefined
          || outcomeMultiplier(outcome) >= instruction.minMultiplier)
        && (instruction.maxMultiplier === null
          || instruction.maxMultiplier === undefined
          || outcomeMultiplier(outcome) <= instruction.maxMultiplier))
    : targetMatches;
  const candidateAudit = (outcome: BattleCandidateOutcome) => ({
    blockNumber: outcome.blockNumber,
    winningTeam: outcome.winningTeam,
    creatorTeam: outcome.creatorTeam,
    creatorWonBattle: outcome.creatorWonBattle,
    creatorCost: outcome.creatorCost,
    creatorProfitLoss: outcome.creatorProfitLoss,
    creatorMultiplier: outcomeMultiplier(outcome),
  });
  const source = instruction?.source
    ?? (instruction ? "user" : userOnlyLoses ? "global" : "random");
  return {
    version: 1,
    source,
    controlKind: instruction?.mode === "force_losses"
      ? source === "global" ? "global_force_losses" : "user_force_losses"
      : instruction
        ? source === "global" ? "global_rule" : "user_rule"
        : userOnlyLoses ? "legacy_global_losses" : "random",
    randomBlockNumber,
    battleMode: battle.mode,
    crazyMode: battle.crazyMode,
    currency: battle.currency,
    requestedTarget,
    requestedStrategy,
    requestedMinMultiplier: instruction?.minMultiplier ?? null,
    requestedMaxMultiplier: instruction?.maxMultiplier ?? null,
    fallbackReason: requestedTarget !== null && requestedTarget !== "any"
        && targetMatches.length === 0
      ? "target_unavailable"
      : hasRange && rangeMatches.length === 0
        ? "range_unavailable"
        : null,
    selected: candidateAudit(selected),
    candidates: outcomes.map(candidateAudit),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function chainInfoForSelectedBlock(
  selection: EosRandomBlockSelection,
  selectedBlock: EosBlockCandidate,
): Record<string, unknown> {
  return {
    ...selection.chainInfo,
    last_irreversible_block_num: selectedBlock.blockNumber,
    last_irreversible_block_id: selectedBlock.blockHash,
    last_irreversible_block_time: selectedBlock.blockTimestamp,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`EOS provider returned HTTP ${response.status}`);
  }
  return response.json();
}

export class EosRandomBlockService implements EosRandomBlockSource {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly randomIndex: RandomIndex = randomInt,
  ) {}

  async select(): Promise<EosRandomBlockSelection> {
    const snapshot = await this.fetchSnapshot();
    const selectedIndex = this.randomIndex(snapshot.candidates.length);
    return {
      ...snapshot,
      selectedIndex,
      selectedBlock: snapshot.candidates[selectedIndex]!,
    };
  }

  async getBlock(
    blockNumOrId: number | string,
  ): Promise<Record<string, unknown>> {
    const controllers = EOS_ENDPOINTS.map(() => new AbortController());
    const timers = controllers.map((controller) =>
      setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
    );
    const attempts = EOS_ENDPOINTS.map(async (endpoint, index) => {
      const block = await responseJson(await this.fetcher(
        `${endpoint}/v1/chain/get_block`,
        {
          method: "POST",
          signal: controllers[index]!.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ block_num_or_id: blockNumOrId }),
        },
      ));
      if (!isRecord(block)) {
        throw new Error("EOS provider returned an invalid block");
      }
      if (
        typeof block.id !== "string"
        || !BLOCK_ID_PATTERN.test(block.id)
        || !Number.isSafeInteger(block.block_num)
        || (typeof blockNumOrId === "number" && block.block_num !== blockNumOrId)
      ) {
        throw new Error("EOS provider returned the wrong block");
      }
      return block;
    });
    try {
      return await Promise.any(attempts);
    } catch (error) {
      throw new Error("All EOS providers failed", { cause: error });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    }
  }

  private async fetchSnapshot(): Promise<
    Omit<EosRandomBlockSelection, "selectedIndex" | "selectedBlock">
  > {
    const controllers = EOS_ENDPOINTS.map(() => new AbortController());
    const timers = controllers.map((controller) =>
      setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
    );
    const attempts = EOS_ENDPOINTS.map(async (endpoint, index) => {
      const candidates = await this.fetchCandidates(
        endpoint,
        controllers[index]!.signal,
      );
      return {
        provider: endpoint,
        chainInfo: candidates.chainInfo,
        candidates: candidates.blocks,
      };
    });

    try {
      return await Promise.any(attempts);
    } catch (error) {
      throw new Error("All EOS providers failed", { cause: error });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    }
  }

  private async fetchCandidates(
    endpoint: string,
    signal: AbortSignal,
  ): Promise<{
    chainInfo: Record<string, unknown>;
    blocks: EosBlockCandidate[];
  }> {
    const info = await responseJson(await this.fetcher(
      `${endpoint}/v1/chain/get_info`,
      { signal, headers: { accept: "application/json" } },
    ));
    if (!isRecord(info)) {
      throw new Error("EOS provider returned invalid chain info");
    }
    const latest = info.last_irreversible_block_num;
    if (!Number.isSafeInteger(latest) || (latest as number) < BLOCK_COUNT) {
      throw new Error("EOS provider returned an invalid irreversible block");
    }

    const blocks = await Promise.all(
      Array.from({ length: BLOCK_COUNT }, async (_, index) => {
        const blockNumber = (latest as number) - index;
        const block = await responseJson(await this.fetcher(
          `${endpoint}/v1/chain/get_block`,
          {
            method: "POST",
            signal,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ block_num_or_id: blockNumber }),
          },
        ));
        const returnedNumber = isRecord(block) ? block.block_num : null;
        const blockHash = isRecord(block) ? block.id : null;
        const blockTimestamp = isRecord(block) ? block.timestamp : null;
        if (
          returnedNumber !== blockNumber
          || typeof blockHash !== "string"
          || !BLOCK_ID_PATTERN.test(blockHash)
          || typeof blockTimestamp !== "string"
          || blockTimestamp.length === 0
        ) {
          throw new Error("EOS provider returned an invalid block");
        }
        return {
          blockNumber,
          blockHash: blockHash.toLowerCase(),
          blockTimestamp,
        };
      }),
    );
    return { chainInfo: info, blocks };
  }
}

/**
 * The only routes that answer without a bearer token.
 *
 * Both read nothing but public EOS chain data: `GET /v1/chain/get_info` returns
 * a chain-info payload for a randomly selected recent block, and
 * `POST /v1/chain/get_block` passes a block straight through. Neither takes a
 * userID, so neither can reach the database or a user's battle.
 *
 * Deliberately NOT here:
 *   - `POST /v1/chain/get_info`, whose body may carry a userID. That branch
 *     reads the caller-named user's in-progress battle and consumes their
 *     configured rule sequence, so it goes through the normal bearer check.
 */
export function isUnauthenticatedEosRandomBlockRequest(
  method: string,
  pathname: string | undefined,
): boolean {
  return (method === "GET" && pathname === EOS_CHAIN_INFO_PATH)
    || (method === "POST" && pathname === EOS_CHAIN_BLOCK_PATH);
}

export async function registerEosRandomBlockRoutes(
  app: FastifyInstance,
  source: EosRandomBlockSource = new EosRandomBlockService(),
  battleOutcomes?: BattleOutcomeSource,
  testConfig?: BattleTestConfigSource,
  environmentRouting?: EosBattleEnvironmentRouting,
): Promise<void> {
  const environmentSchema = z.enum(["dev", "prod"]);
  type ResolvedEnvironment = {
    environment?: BattleTestEnvironment;
    battleOutcomes?: BattleOutcomeSource;
    testConfig?: BattleTestConfigSource;
  };
  type EnvironmentResolution =
    | { ok: true; resources: ResolvedEnvironment }
    | { ok: false; status: 400 | 503; error: "invalid_environment" | "environment_unavailable" };

  const resolveEnvironment = (
    request: FastifyRequest,
    needs: "config" | "battle",
  ): EnvironmentResolution => {
    if (!environmentRouting) {
      return { ok: true, resources: { battleOutcomes, testConfig } };
    }
    const parsed = environmentSchema.safeParse(
      request.headers[EOS_ENVIRONMENT_HEADER],
    );
    if (!parsed.success) {
      return { ok: false, status: 400, error: "invalid_environment" };
    }
    const selected = environmentRouting[parsed.data];
    if (!selected?.testConfig || (needs === "battle" && !selected.battleOutcomes)) {
      return { ok: false, status: 503, error: "environment_unavailable" };
    }
    return {
      ok: true,
      resources: { environment: parsed.data, ...selected },
    };
  };
  const sendEnvironmentError = (
    reply: FastifyReply,
    resolution: Extract<EnvironmentResolution, { ok: false }>,
  ) => reply.code(resolution.status).send({ error: resolution.error });

  const selectForBattle = async (
    userID: string,
    battleID: string | undefined,
    resources: ResolvedEnvironment,
  ) => {
    const selectedOutcomes = resources.battleOutcomes;
    const selectedConfig = resources.testConfig;
    if (!selectedOutcomes) {
      throw new BattleSimulationError("battle_data_incomplete", 409);
    }
    if (battleID && selectedConfig?.getBattleSelection) {
      const cachedResponse = await selectedConfig.getBattleSelection(userID, battleID);
      if (cachedResponse) return { cachedResponse };
    }
    const selection = await source.select();
    const battle = await selectedOutcomes.simulate(
      userID,
      battleID,
      selection.candidates,
    );
    const { outcomes: simulatedOutcomes, ...battleSummary } = battle;
    if (selectedConfig?.getBattleSelection) {
      const cachedResponse = await selectedConfig.getBattleSelection(
        userID,
        battleSummary.battleId,
      );
      if (cachedResponse) return { cachedResponse };
    }
    let instruction: BattleTestUserInstruction | null = null;
    if (selectedConfig?.consumeUserInstruction) {
      instruction = await selectedConfig.consumeUserInstruction(
        userID,
        battleSummary.battleId,
      );
    }
    let userOnlyLoses = false;
    if (!instruction && selectedConfig) {
      try {
        userOnlyLoses = (await selectedConfig.get()).userOnlyLoses;
      } catch (error) {
        app.log.warn(
          { err: error, event: "eos_random_block.config_read_failed" },
          "EOS battle test config unavailable; using random selection",
        );
      }
    }
    const selected = instruction
      ? selectBattleTestInstructionOutcome(
          simulatedOutcomes,
          selection.selectedBlock.blockNumber,
          instruction,
        )
      : selectBattleTestOutcome(
          simulatedOutcomes,
          selection.selectedBlock.blockNumber,
          userOnlyLoses,
        );
    const selectedBlock = selection.candidates.find(
      (candidate) => candidate.blockNumber === selected.blockNumber,
    );
    if (!selectedBlock) {
      throw new BattleSimulationError("battle_data_incomplete", 409);
    }
    const response = chainInfoForSelectedBlock(selection, selectedBlock);
    const audit = selectionAudit(
      simulatedOutcomes,
      selected,
      instruction,
      userOnlyLoses,
      selection.selectedBlock.blockNumber,
      battleSummary,
    );
    const savedResponse = selectedConfig?.saveBattleSelection
      ? await selectedConfig.saveBattleSelection(
          userID,
          battleSummary.battleId,
          response,
          audit,
        )
      : response;
    return {
      selection,
      battleSummary,
      simulatedOutcomes,
      selected,
      selectedBlock,
      instruction,
      userOnlyLoses,
      environment: resources.environment,
      savedResponse,
    };
  };

  /**
   * One line per steering decision: which window was fetched, which block came
   * back, and what made that choice. Without it a settled battle leaves no
   * trace of whether its block was picked at random or steered — and the
   * consumed rule is gone from the sequence by then.
   */
  const logSelection = (
    request: FastifyRequest,
    userID: string,
    battleID: string | undefined,
    resolved: Awaited<ReturnType<typeof selectForBattle>>,
  ): void => {
    if ("cachedResponse" in resolved) return;
    request.log.info(
      {
        event: "eos_random_block.selected",
        requestId: request.id,
        environment: resolved.environment ?? null,
        userId: userID,
        battleId: battleID ?? resolved.battleSummary.battleId,
        provider: resolved.selection.provider,
        candidateBlockNumbers: resolved.selection.candidates.map(
          (candidate) => candidate.blockNumber,
        ),
        randomBlockNumber: resolved.selection.selectedBlock.blockNumber,
        selectedBlockNumber: resolved.selectedBlock.blockNumber,
        steeredBy: resolved.instruction
          ? resolved.instruction.mode === "force_losses"
            ? `${resolved.instruction.source ?? "user"}_force_losses`
            : `${resolved.instruction.source ?? "user"}_rule`
          : resolved.userOnlyLoses
            ? "global_only_loses"
            : "random",
        ruleTarget: resolved.instruction?.target ?? null,
        ruleStrategy: resolved.instruction?.strategy ?? null,
        ruleMinMultiplier: resolved.instruction?.minMultiplier ?? null,
        ruleMaxMultiplier: resolved.instruction?.maxMultiplier ?? null,
        creatorWonBattle: resolved.selected.creatorWonBattle,
        creatorProfitLoss: resolved.selected.creatorProfitLoss,
        creatorMultiplier: resolved.selected.creatorMultiplier ?? null,
      },
      "EOS block selected for battle",
    );
  };

  const routedConfigs = environmentRouting
    ? Object.values(environmentRouting).flatMap((entry) =>
        entry?.testConfig ? [entry.testConfig] : []
      )
    : testConfig ? [testConfig] : [];
  if (routedConfigs.length > 0) {
    app.get(EOS_RANDOM_BLOCK_CONFIG_PATH, async (request, reply) => {
      const resolution = resolveEnvironment(request, "config");
      if (!resolution.ok) return sendEnvironmentError(reply, resolution);
      return { data: await resolution.resources.testConfig!.get() };
    });
    app.put(EOS_RANDOM_BLOCK_CONFIG_PATH, async (request, reply) => {
      const resolution = resolveEnvironment(request, "config");
      if (!resolution.ok) return sendEnvironmentError(reply, resolution);
      const selectedConfig = resolution.resources.testConfig!;
      const parsed = flowUpdateSchema.safeParse(request.body);
      const legacy = configUpdateSchema.safeParse(request.body);
      if (!parsed.success && !legacy.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      let saved;
      let actor: string;
      if (parsed.success) {
        actor = parsed.data.actor;
        saved = selectedConfig.setFlow
          ? await selectedConfig.setFlow(parsed.data.rules, parsed.data.persistent,
              parsed.data.randomized, parsed.data.enabled, actor,
              parsed.data.forceAllLosses)
          : await selectedConfig.set(parsed.data.enabled, actor);
      } else {
        if (!legacy.success) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        actor = legacy.data.actor;
        saved = await selectedConfig.set(legacy.data.userOnlyLoses, actor);
      }
      request.log.info(
        {
          event: "eos_random_block.global_config_updated",
          requestId: request.id,
          environment: resolution.resources.environment ?? saved.environment ?? null,
          actor,
          enabled: saved.enabled,
          persistent: saved.persistent,
          randomized: saved.randomized,
          rules: saved.rules ?? [],
          forceAllLosses: saved.forceAllLosses ?? false,
        },
        "EOS battle test global config updated",
      );
      return { data: saved };
    });
    const hasUserConfigRoutes = routedConfigs.some((config) =>
      config.listUsers && config.setUser && config.deleteUser
    );
    if (hasUserConfigRoutes) {
      app.get(EOS_RANDOM_BLOCK_USER_CONFIG_PATH, async (request, reply) => {
        const resolution = resolveEnvironment(request, "config");
        if (!resolution.ok) return sendEnvironmentError(reply, resolution);
        const selectedConfig = resolution.resources.testConfig!;
        if (!selectedConfig.listUsers) {
          return reply.code(503).send({ error: "environment_unavailable" });
        }
        return { data: await selectedConfig.listUsers() };
      });
      app.get(
        `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/:userId/selections`,
        async (request, reply) => {
          const resolution = resolveEnvironment(request, "config");
          if (!resolution.ok) return sendEnvironmentError(reply, resolution);
          const selectedConfig = resolution.resources.testConfig!;
          if (!selectedConfig.listUserSelections) {
            return reply.code(503).send({ error: "environment_unavailable" });
          }
          const userId = z.string().trim().min(1).max(100).safeParse(
            (request.params as { userId?: unknown }).userId,
          );
          const query = userSelectionQuerySchema.safeParse(request.query);
          if (!userId.success || !query.success) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          return {
            environment: resolution.resources.environment,
            data: await selectedConfig.listUserSelections(
              userId.data,
              query.data.limit,
            ),
          };
        },
      );
      app.put(
        `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/:userId`,
        async (request, reply) => {
          const resolution = resolveEnvironment(request, "config");
          if (!resolution.ok) return sendEnvironmentError(reply, resolution);
          const selectedConfig = resolution.resources.testConfig!;
          if (!selectedConfig.setUser) {
            return reply.code(503).send({ error: "environment_unavailable" });
          }
          const userId = z.string().trim().min(1).max(100).safeParse(
            (request.params as { userId?: unknown }).userId,
          );
          const parsed = userConfigUpdateSchema.safeParse(request.body);
          if (!userId.success || !parsed.success) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          const saved = selectedConfig.setUserFlow
            ? await selectedConfig.setUserFlow(userId.data, parsed.data.username,
                parsed.data.rules, parsed.data.persistent, parsed.data.randomized,
                parsed.data.enabled, parsed.data.actor, parsed.data.forceLosses)
            : await selectedConfig.setUser(userId.data, parsed.data.username,
                parsed.data.rules, parsed.data.persistent, parsed.data.enabled,
                parsed.data.actor);
          request.log.info(
            {
              event: "eos_random_block.user_sequence_updated",
              requestId: request.id,
              environment: resolution.resources.environment ?? saved.environment ?? null,
              actor: parsed.data.actor,
              userId: userId.data,
              username: parsed.data.username,
              enabled: parsed.data.enabled,
              persistent: parsed.data.persistent,
              randomized: parsed.data.randomized,
              forceLosses: parsed.data.forceLosses,
              rules: parsed.data.rules,
            },
            "EOS battle test user sequence updated",
          );
          return { data: saved };
        },
      );
      app.patch(
        `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/:userId/force-losses`,
        async (request, reply) => {
          const resolution = resolveEnvironment(request, "config");
          if (!resolution.ok) return sendEnvironmentError(reply, resolution);
          const selectedConfig = resolution.resources.testConfig!;
          if (!selectedConfig.setUserForceLosses) {
            return reply.code(503).send({ error: "environment_unavailable" });
          }
          const userId = z.string().trim().min(1).max(100).safeParse(
            (request.params as { userId?: unknown }).userId,
          );
          const parsed = userForceLossesUpdateSchema.safeParse(request.body);
          if (!userId.success || !parsed.success) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          const saved = await selectedConfig.setUserForceLosses(
            userId.data,
            parsed.data.forceLosses,
            parsed.data.actor,
          );
          if (!saved) return reply.code(404).send({ error: "user_config_not_found" });
          request.log.info(
            {
              event: "eos_random_block.user_force_losses_updated",
              requestId: request.id,
              environment: resolution.resources.environment ?? saved.environment ?? null,
              actor: parsed.data.actor,
              userId: userId.data,
              forceLosses: parsed.data.forceLosses,
            },
            "EOS battle test per-user loss override updated",
          );
          return { data: saved };
        },
      );
      app.delete(
        `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/:userId`,
        async (request, reply) => {
          const resolution = resolveEnvironment(request, "config");
          if (!resolution.ok) return sendEnvironmentError(reply, resolution);
          const selectedConfig = resolution.resources.testConfig!;
          if (!selectedConfig.deleteUser) {
            return reply.code(503).send({ error: "environment_unavailable" });
          }
          const userId = z.string().trim().min(1).max(100).safeParse(
            (request.params as { userId?: unknown }).userId,
          );
          if (!userId.success) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          await selectedConfig.deleteUser(userId.data);
          request.log.info(
            {
              event: "eos_random_block.user_sequence_deleted",
              requestId: request.id,
              environment: resolution.resources.environment ?? null,
              userId: userId.data,
            },
            "EOS battle test user sequence deleted",
          );
          return reply.code(204).send();
        },
      );
    }
  }

  app.get(EOS_CHAIN_INFO_PATH, async (_request, reply) => {
    try {
      const selection = await source.select();
      return chainInfoForSelectedBlock(selection, selection.selectedBlock);
    } catch {
      return reply.code(503).send({ error: "eos_unavailable" });
    }
  });

  app.post(EOS_CHAIN_INFO_PATH, async (request, reply) => {
    const body = request.body;
    if (body === undefined || (isRecord(body) && Object.keys(body).length === 0)) {
      try {
        const selection = await source.select();
        return chainInfoForSelectedBlock(selection, selection.selectedBlock);
      } catch {
        return reply.code(503).send({ error: "eos_unavailable" });
      }
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const resolution = resolveEnvironment(request, "battle");
    if (!resolution.ok) return sendEnvironmentError(reply, resolution);
    try {
      const resolved = await selectForBattle(
        parsed.data.userID,
        parsed.data.battleID,
        resolution.resources,
      );
      if ("cachedResponse" in resolved) return resolved.cachedResponse;
      logSelection(request, parsed.data.userID, parsed.data.battleID, resolved);
      return resolved.savedResponse;
    } catch (error) {
      if (error instanceof BattleSimulationError) {
        request.log.warn(
          {
            event: "eos_random_block.battle_simulation_rejected",
            requestId: request.id,
            reason: error.code,
            userId: parsed.data.userID,
            battleId: parsed.data.battleID ?? null,
          },
          "EOS battle simulation rejected",
        );
        return reply.code(error.status).send({ error: error.code });
      }
      request.log.warn(
        { err: error, event: "eos_random_block.providers_failed" },
        "EOS block selection failed",
      );
      return reply.code(503).send({ error: "eos_unavailable" });
    }
  });

  app.post(EOS_CHAIN_BLOCK_PATH, async (request, reply) => {
    const parsed = chainBlockRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!source.getBlock) {
      return reply.code(503).send({ error: "eos_unavailable" });
    }
    try {
      return await source.getBlock(parsed.data.block_num_or_id);
    } catch {
      return reply.code(503).send({ error: "eos_unavailable" });
    }
  });

  // `POST /v1/testing/eos-random-block` used to live here. It was removed: it
  // answered without a bearer token, yet a userID in its body made it read that
  // user's in-progress battle out of the database and return every candidate
  // ending — and its 400 handler echoed the raw Zod issue, handing an anonymous
  // caller the exact request shape. The same selection is still reachable
  // through `POST /v1/chain/get_info`, which now requires a token.
}
