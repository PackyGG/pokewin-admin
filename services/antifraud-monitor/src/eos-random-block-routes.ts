import { randomInt } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const EOS_RANDOM_BLOCK_PATH = "/v1/testing/eos-random-block";

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
};

export type EosRandomBlockSelection = {
  provider: string;
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
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    const firstProvider = this.randomIndex(EOS_ENDPOINTS.length);
    let lastError: unknown = new Error("No EOS provider was attempted");

    for (let offset = 0; offset < EOS_ENDPOINTS.length; offset += 1) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= TOTAL_TIMEOUT_MS) break;
      const endpoint = EOS_ENDPOINTS[
        (firstProvider + offset) % EOS_ENDPOINTS.length
      ]!;
      try {
        const candidates = await this.fetchCandidates(
          endpoint,
          Math.min(PROVIDER_TIMEOUT_MS, TOTAL_TIMEOUT_MS - elapsed),
        );
        const selectedIndex = this.randomIndex(candidates.length);
        return {
          provider: endpoint,
          selectedIndex,
          selectedBlock: candidates[selectedIndex]!,
          candidates,
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
  ): Promise<EosBlockCandidate[]> {
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const info = await responseJson(await this.fetcher(
      `${endpoint}/v1/chain/get_info`,
      { signal, headers: { accept: "application/json" } },
    ));
    const latest = isRecord(info) ? info.last_irreversible_block_num : null;
    if (!Number.isSafeInteger(latest) || (latest as number) < BLOCK_COUNT) {
      throw new Error("EOS provider returned an invalid irreversible block");
    }

    return Promise.all(
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
        if (
          returnedNumber !== blockNumber
          || typeof blockHash !== "string"
          || !BLOCK_ID_PATTERN.test(blockHash)
        ) {
          throw new Error("EOS provider returned an invalid block");
        }
        return { blockNumber, blockHash: blockHash.toLowerCase() };
      }),
    );
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
): Promise<void> {
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
        // Match the battle backend's EOS result contract: callers only receive
        // the block hash that is fed into battle execution. Provider choice,
        // candidate blocks, and the submitted user remain internal diagnostics.
        return { blockHash: selection.selectedBlock.blockHash };
      } catch (error) {
        request.log.warn(
          { err: error, event: "eos_random_block.providers_failed" },
          "EOS random block selection failed",
        );
        return reply.code(503).send({ error: "eos_unavailable" });
      }
    },
  );
}
