import { unstable_cache } from "next/cache";

/**
 * Public EOS mainnet RPC providers — mirrors `backend/src/lib/eos.ts`'s
 * `EOS_ENDPOINTS` (the list the battle-resolution service shuffles through
 * on a failover basis to fetch ONE block per battle). Duplicated here
 * rather than imported: `backend` is a separate repo/deploy, not a shared
 * package, and this list is public infrastructure, not a secret. Used here
 * the same way backend uses it — shuffled failover — to find one endpoint
 * that resolves the battle's recorded block, then pull the 4 blocks before
 * it from that same endpoint for context.
 */
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

const EOS_FETCH_TIMEOUT_MS = 6_000;
const HISTORY_DEPTH = 4;

type BlockFetchResult =
  | { status: "ok"; blockNum: number; blockHash: string; timestamp: string; producer: string }
  | { status: "error"; error: string };

async function fetchBlockFromEndpoint(
  endpoint: string,
  blockNumOrId: string | number,
): Promise<BlockFetchResult> {
  try {
    const res = await fetch(`${endpoint}/v1/chain/get_block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_num_or_id: blockNumOrId }),
      signal: AbortSignal.timeout(EOS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as {
      id?: string;
      block_num?: number;
      timestamp?: string;
      producer?: string;
    };
    if (typeof data.block_num !== "number" || !data.id) {
      throw new Error("Missing block_num/id in response");
    }
    return {
      status: "ok",
      blockNum: data.block_num,
      blockHash: data.id,
      timestamp: data.timestamp ?? "",
      producer: data.producer ?? "",
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export type EosHistoryBlock =
  | { blockNum: number; status: "ok"; blockHash: string; timestamp: string; producer: string }
  | { blockNum: number; status: "error"; error: string };

export type EosBlockHistory =
  | { status: "ok"; endpoint: string; blocks: EosHistoryBlock[] }
  | { status: "error"; error: string };

/**
 * Resolves a battle's stored `eos_block_hash` against the public EOS RPC
 * providers (shuffled failover, same strategy as the battle-resolution
 * service — first endpoint that resolves the hash wins), then pulls the
 * `HISTORY_DEPTH` blocks immediately before it FROM THAT SAME ENDPOINT so
 * an admin can see the block actually used plus its immediate on-chain
 * context. `blocks[0]` is always the recorded battle block; the rest are
 * strictly descending block numbers before it.
 *
 * Cached 1h, keyed on the hash — chain data is immutable once a block
 * exists, so a successful lookup never goes stale. On-demand only (called
 * from the battle-row expand action), never eager-loaded for a whole list
 * of battles.
 */
export const verifyEosBlockWithHistory = unstable_cache(
  async (eosBlockHash: string): Promise<EosBlockHistory> => {
    const endpoints = shuffle(EOS_ENDPOINTS);
    const errors: string[] = [];
    let found: { endpoint: string; block: Extract<BlockFetchResult, { status: "ok" }> } | null = null;

    for (const endpoint of endpoints) {
      const result = await fetchBlockFromEndpoint(endpoint, eosBlockHash);
      if (result.status === "ok") {
        found = { endpoint, block: result };
        break;
      }
      errors.push(`${endpoint}: ${result.error}`);
    }

    if (!found) {
      return {
        status: "error",
        error: `All ${endpoints.length} EOS endpoints failed to resolve this block hash.`,
      };
    }

    const { endpoint, block } = found;
    const priorNums = Array.from({ length: HISTORY_DEPTH }, (_, i) => block.blockNum - (i + 1));
    const priorResults = await Promise.all(
      priorNums.map((num) => fetchBlockFromEndpoint(endpoint, num)),
    );

    const blocks: EosHistoryBlock[] = [
      {
        blockNum: block.blockNum,
        status: "ok",
        blockHash: block.blockHash,
        timestamp: block.timestamp,
        producer: block.producer,
      },
      ...priorResults.map((r, i): EosHistoryBlock =>
        r.status === "ok"
          ? { blockNum: r.blockNum, status: "ok", blockHash: r.blockHash, timestamp: r.timestamp, producer: r.producer }
          : { blockNum: priorNums[i]!, status: "error", error: r.error },
      ),
    ];

    return { status: "ok", endpoint, blocks };
  },
  ["eos-block-history-v2"],
  { revalidate: 3600 },
);
