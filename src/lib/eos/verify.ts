import { unstable_cache } from "next/cache";

/**
 * Public EOS mainnet RPC providers — mirrors `backend/src/lib/eos.ts`'s
 * `EOS_ENDPOINTS` (the list the battle-resolution service shuffles through
 * on a failover basis to fetch ONE block per battle). Duplicated here
 * rather than imported: `backend` is a separate repo/deploy, not a shared
 * package, and this list is public infrastructure, not a secret. Used here
 * for the OPPOSITE purpose — instead of racing for the first responder, we
 * ask every one of them the same question (by block hash) so an admin can
 * see all 13 independently confirm the same on-chain block.
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

export type EosEndpointCheck =
  | {
      endpoint: string;
      status: "ok";
      blockNum: number;
      timestamp: string;
      producer: string;
    }
  | { endpoint: string; status: "error"; error: string };

async function fetchBlockFromEndpoint(
  endpoint: string,
  blockHash: string,
): Promise<EosEndpointCheck> {
  try {
    const res = await fetch(`${endpoint}/v1/chain/get_block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_num_or_id: blockHash }),
      signal: AbortSignal.timeout(EOS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as {
      block_num?: number;
      timestamp?: string;
      producer?: string;
    };
    if (typeof data.block_num !== "number") {
      throw new Error("Missing block_num in response");
    }
    return {
      endpoint,
      status: "ok",
      blockNum: data.block_num,
      timestamp: data.timestamp ?? "",
      producer: data.producer ?? "",
    };
  } catch (err) {
    return {
      endpoint,
      status: "error",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Cross-checks a battle's stored `eos_block_hash` against every one of the
 * 13 public EOS RPC providers, looked up BY HASH (`block_num_or_id` accepts
 * either) — no block number needed, since a block's hash is a permanent,
 * content-addressed identifier on the chain. A hash that resolves
 * consistently across independent providers is strong evidence the block
 * is real, was never re-fetched/altered, and existed at the recorded time.
 *
 * Cached 1h, keyed on the hash — the underlying chain data is immutable
 * once a block exists, so a successful lookup never goes stale. On-demand
 * only (called from the battle-row expand action), never eager-loaded for
 * a whole list of battles.
 */
export const verifyEosBlockAcrossEndpoints = unstable_cache(
  async (eosBlockHash: string): Promise<EosEndpointCheck[]> => {
    return Promise.all(
      EOS_ENDPOINTS.map((endpoint) =>
        fetchBlockFromEndpoint(endpoint, eosBlockHash),
      ),
    );
  },
  ["eos-block-verify-v1"],
  { revalidate: 3600 },
);

export const EOS_ENDPOINT_COUNT = EOS_ENDPOINTS.length;
