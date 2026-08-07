import { randomInt } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  BattleSimulationError,
  type BattleCandidateOutcome,
  type BattleOutcomeSource,
} from "./battle-outcome-simulator.js";
import type { BattleTestConfigSource } from "./battle-test-config.js";

export const EOS_RANDOM_BLOCK_PATH = "/v1/testing/eos-random-block";
export const EOS_RANDOM_BLOCK_CONFIG_PATH = `${EOS_RANDOM_BLOCK_PATH}/config`;

const EOS_ENDPOINTS = [
  "https://eos.api.eosnation.io",
  "https://eos.eosusa.io",
  "https://api.eostitan.com",
  "https://mainnet.genereos.io",
  "https://api.main.alohaeos.com",
  "https://mainnet.eosio.sg",
  "https://api.eosrio.io",
  "https://eos.hyperion.eosrio.io",
  "https://mainnet.eosamsterdam.net",
  "https://eos.newdex.one",
  "https://api.eos.detroitledger.tech",
  "https://api.eossupport.io",
  "https://api.eospglmlt.com",
] as const;

const BLOCK_COUNT = 5;
const PROVIDER_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 12_000;
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
    const startedAt = Date.now();
    let lastError: unknown = new Error("No EOS provider was attempted");

    // Keep the fastest reliable provider first. Randomizing this previously
    // made otherwise identical test requests wait through multiple dead
    // provider timeouts before reaching a healthy endpoint.
    for (const endpoint of EOS_ENDPOINTS) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= TOTAL_TIMEOUT_MS) break;
      try {
        const candidates = await this.fetchCandidates(
          endpoint,
          Math.min(PROVIDER_TIMEOUT_MS, TOTAL_TIMEOUT_MS - elapsed),
        );
        const selectedIndex = this.randomIndex(candidates.blocks.length);
        return {
          provider: endpoint,
          chainInfo: candidates.chainInfo,
          selectedIndex,
          selectedBlock: candidates.blocks[selectedIndex]!,
          candidates: candidates.blocks,
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error("All EOS providers failed", { cause: lastError });
  }

  private async fetchCandidates(
    endpoint: string,
    timeoutMs: number,
  ): Promise<{
    chainInfo: Record<string, unknown>;
    blocks: EosBlockCandidate[];
  }> {
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
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
  return method === "POST" && pathname === EOS_RANDOM_BLOCK_PATH;
}

export async function registerEosRandomBlockRoutes(
  app: FastifyInstance,
  source: EosRandomBlockSource = new EosRandomBlockService(),
  battleOutcomes?: BattleOutcomeSource,
  testConfig?: BattleTestConfigSource,
): Promise<void> {
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
  }

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
        if (!battleOutcomes) {
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
        const battle = await battleOutcomes.simulate(
          parsed.data.userID,
          parsed.data.battleID,
          selection.candidates,
        );
        let userOnlyLoses = false;
        if (testConfig) {
          try {
            userOnlyLoses = (await testConfig.get()).userOnlyLoses;
          } catch (error) {
            request.log.warn(
              { err: error, event: "eos_random_block.config_read_failed" },
              "EOS battle test config unavailable; using random selection",
            );
          }
        }
        const selected = selectBattleTestOutcome(
          battle.outcomes,
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
          ...chainInfoForSelectedBlock(selection, selectedBlock),
          ...battle,
          selectedBlockNumber: selected.blockNumber,
          selected: {
            blockNumber: selectedBlock.blockNumber,
            blockId: selectedBlock.blockHash,
            timestamp: selectedBlock.blockTimestamp,
            provider: selection.provider,
            winningTeam: selected.winningTeam,
            creatorTeam: selected.creatorTeam,
            creatorWonBattle: selected.creatorWonBattle,
            creatorCost: selected.creatorCost,
            creatorProfitLoss: selected.creatorProfitLoss,
          },
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
