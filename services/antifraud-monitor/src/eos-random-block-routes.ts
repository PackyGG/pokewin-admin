import { randomInt } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  BattleSimulationError,
  type BattleCandidateOutcome,
  type BattleOutcomeSource,
} from "./battle-outcome-simulator.js";
import type {
  BattleTestConfigSource,
  BattleTestUserInstruction,
} from "./battle-test-config.js";

export const EOS_RANDOM_BLOCK_PATH = "/v1/testing/eos-random-block";
export const EOS_RANDOM_BLOCK_CONFIG_PATH = `${EOS_RANDOM_BLOCK_PATH}/config`;
export const EOS_RANDOM_BLOCK_USER_CONFIG_PATH =
  `${EOS_RANDOM_BLOCK_CONFIG_PATH}/users`;
export const EOS_CHAIN_INFO_PATH = "/v1/chain/get_info";
export const EOS_CHAIN_BLOCK_PATH = "/v1/chain/get_block";

const EOS_ENDPOINTS = [
  "https://api.eostitan.com",
  "https://mainnet.genereos.io",
  "https://mainnet.eosamsterdam.net",
  "https://eos.eosusa.io",
  "https://eos.api.eosnation.io",
  "https://api.eospglmlt.com",
  "https://eos.newdex.one",
  "https://api.eos.detroitledger.tech",
  "https://api.eossupport.io",
  "https://api.main.alohaeos.com",
  "https://mainnet.eosio.sg",
  "https://api.eosrio.io",
  "https://eos.hyperion.eosrio.io",
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
  battleID: z.uuid(),
}).strict();

const configUpdateSchema = z.object({
  userOnlyLoses: z.boolean(),
  actor: z.string().trim().min(1).max(120),
}).strict();

const userRuleSchema = z.object({
  target: z.enum(["loss", "win", "any"]),
  strategy: z.enum(["random", "lowest_profit", "highest_profit"]),
  count: z.number().int().min(1).max(100),
}).strict();

const userConfigUpdateSchema = z.object({
  username: z.string().trim().min(1).max(100).nullable(),
  rules: z.array(userRuleSchema).min(1).max(20),
  enabled: z.boolean(),
  actor: z.string().trim().min(1).max(120),
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
  const losses = outcomes.filter((outcome) => outcome.creatorProfitLoss < 0);
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
  const matching = instruction.target === "any"
    ? outcomes
    : outcomes.filter((outcome) =>
      instruction.target === "win"
        ? outcome.creatorWonBattle
        : !outcome.creatorWonBattle
    );

  if (matching.length === 0) {
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
  if (instruction.strategy === "lowest_profit") {
    return matching.reduce((lowest, outcome) =>
      outcome.creatorProfitLoss < lowest.creatorProfitLoss ? outcome : lowest
    );
  }
  if (instruction.strategy === "highest_profit") {
    return matching.reduce((highest, outcome) =>
      outcome.creatorProfitLoss > highest.creatorProfitLoss ? outcome : highest
    );
  }
  return matching.find((outcome) => outcome.blockNumber === randomBlockNumber)
    ?? matching[randomIndex(matching.length)]!;
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

function battleEnding(
  provider: string,
  block: EosBlockCandidate,
  outcome: BattleCandidateOutcome,
): Record<string, unknown> {
  return {
    blockNumber: block.blockNumber,
    blockId: block.blockHash,
    timestamp: block.blockTimestamp,
    provider,
    winningTeam: outcome.winningTeam,
    creatorTeam: outcome.creatorTeam,
    creatorWonBattle: outcome.creatorWonBattle,
    creatorCost: outcome.creatorCost,
    creatorProfitLoss: outcome.creatorProfitLoss,
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

export function isUnauthenticatedEosRandomBlockRequest(
  method: string,
  pathname: string | undefined,
): boolean {
  return (method === "POST" && pathname === EOS_RANDOM_BLOCK_PATH)
    || ((method === "GET" || method === "POST")
      && pathname === EOS_CHAIN_INFO_PATH)
    || (method === "POST" && pathname === EOS_CHAIN_BLOCK_PATH);
}

export async function registerEosRandomBlockRoutes(
  app: FastifyInstance,
  source: EosRandomBlockSource = new EosRandomBlockService(),
  battleOutcomes?: BattleOutcomeSource,
  testConfig?: BattleTestConfigSource,
): Promise<void> {
  const selectForBattle = async (userID: string, battleID: string) => {
    if (!battleOutcomes) {
      throw new BattleSimulationError("battle_data_incomplete", 409);
    }
    const selection = await source.select();
    const battle = await battleOutcomes.simulate(
      userID,
      battleID,
      selection.candidates,
    );
    const { outcomes: simulatedOutcomes, ...battleSummary } = battle;
    let instruction: BattleTestUserInstruction | null = null;
    if (testConfig?.consumeUserInstruction) {
      try {
        instruction = await testConfig.consumeUserInstruction(userID);
      } catch (error) {
        app.log.warn(
          { err: error, event: "eos_random_block.user_config_read_failed" },
          "EOS user sequence unavailable; using global configuration",
        );
      }
    }
    let userOnlyLoses = false;
    if (!instruction && testConfig) {
      try {
        userOnlyLoses = (await testConfig.get()).userOnlyLoses;
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
    return {
      selection,
      battleSummary,
      simulatedOutcomes,
      selected,
      selectedBlock,
    };
  };

  if (testConfig) {
    app.get(EOS_RANDOM_BLOCK_CONFIG_PATH, async () => ({
      data: await testConfig.get(),
    }));
    app.put(EOS_RANDOM_BLOCK_CONFIG_PATH, async (request, reply) => {
      const parsed = configUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      return {
        data: await testConfig.set(
          parsed.data.userOnlyLoses,
          parsed.data.actor,
        ),
      };
    });
    if (testConfig.listUsers && testConfig.setUser && testConfig.deleteUser) {
      app.get(EOS_RANDOM_BLOCK_USER_CONFIG_PATH, async () => ({
        data: await testConfig.listUsers!(),
      }));
      app.put(
        `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/:userId`,
        async (request, reply) => {
          const userId = z.string().trim().min(1).max(100).safeParse(
            (request.params as { userId?: unknown }).userId,
          );
          const parsed = userConfigUpdateSchema.safeParse(request.body);
          if (!userId.success || !parsed.success) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          return {
            data: await testConfig.setUser!(
              userId.data,
              parsed.data.username,
              parsed.data.rules,
              parsed.data.enabled,
              parsed.data.actor,
            ),
          };
        },
      );
      app.delete(
        `${EOS_RANDOM_BLOCK_USER_CONFIG_PATH}/:userId`,
        async (request, reply) => {
          const userId = z.string().trim().min(1).max(100).safeParse(
            (request.params as { userId?: unknown }).userId,
          );
          if (!userId.success) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          await testConfig.deleteUser!(userId.data);
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
    try {
      const resolved = await selectForBattle(
        parsed.data.userID,
        parsed.data.battleID,
      );
      return chainInfoForSelectedBlock(
        resolved.selection,
        resolved.selectedBlock,
      );
    } catch (error) {
      if (error instanceof BattleSimulationError) {
        return reply.code(error.status).send({ error: error.code });
      }
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

  app.post(
    EOS_RANDOM_BLOCK_PATH,
    { bodyLimit: 2 * 1024 },
    async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid request",
        });
      }

      try {
        if (!battleOutcomes) {
          const selection = await source.select();
          request.log.info(
            {
              event: "eos_random_block.selected",
              requestId: request.id,
              userId: parsed.data.userID,
              provider: selection.provider,
              selectedBlockNumber: selection.selectedBlock.blockNumber,
            },
            "EOS random block selected",
          );
          return {
            ...chainInfoForSelectedBlock(selection, selection.selectedBlock),
            blockHash: selection.selectedBlock.blockHash,
            selected: {
              blockNumber: selection.selectedBlock.blockNumber,
              blockId: selection.selectedBlock.blockHash,
              timestamp: selection.selectedBlock.blockTimestamp,
              provider: selection.provider,
            },
          };
        }
        const resolved = await selectForBattle(
          parsed.data.userID,
          parsed.data.battleID,
        );
        const {
          selection,
          battleSummary,
          simulatedOutcomes,
          selected,
          selectedBlock,
        } = resolved;
        request.log.info(
          {
            event: "eos_random_block.selected",
            requestId: request.id,
            userId: parsed.data.userID,
            provider: selection.provider,
            selectedBlockNumber: selection.selectedBlock.blockNumber,
          },
          "EOS random block selected",
        );
        const outcomesByBlock = new Map(
          simulatedOutcomes.map((outcome) => [outcome.blockNumber, outcome]),
        );
        const otherPossibleEndings = selection.candidates
          .filter((candidate) => candidate.blockNumber !== selected.blockNumber)
          .map((candidate) => {
            const outcome = outcomesByBlock.get(candidate.blockNumber);
            if (!outcome) {
              throw new BattleSimulationError("battle_data_incomplete", 409);
            }
            return battleEnding(selection.provider, candidate, outcome);
          });
        return {
          ...chainInfoForSelectedBlock(selection, selectedBlock),
          ...battleSummary,
          selectedBlockNumber: selected.blockNumber,
          otherPossibleEndings,
          selected: battleEnding(selection.provider, selectedBlock, selected),
        };
      } catch (error) {
        if (error instanceof BattleSimulationError) {
          request.log.warn(
            {
              event: "eos_random_block.battle_simulation_rejected",
              reason: error.code,
              userId: parsed.data.userID,
            },
            "EOS battle simulation rejected",
          );
          return reply.code(error.status).send({ error: error.code });
        }
        request.log.warn(
          { err: error, event: "eos_random_block.providers_failed" },
          "EOS random block selection failed",
        );
        return reply.code(503).send({ error: "eos_unavailable" });
      }
    },
  );
}
