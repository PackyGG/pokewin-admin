"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getBattleEosBlockHash,
  getBattleSimulationContext,
} from "@/lib/queries/eos-verification";
import {
  verifyEosBlockWithHistory,
  type EosBlockHistory,
} from "@/lib/eos/verify";
import { decryptServerSeed } from "@/lib/eos/provably-fair-crypto";
import {
  simulateBattleOutcomeForBlockHash,
  type SimulatedBattleOutcome,
} from "@/lib/eos/battle-mode-sim";

export type BattleEosVerification = {
  eosBlockHash: string | null;
  blockHistory: EosBlockHistory | null;
};

/**
 * On-demand (row-expand only) live resolve of a battle's stored
 * `eos_block_hash` (plus the 4 blocks before it) via the public EOS RPC
 * providers. Never called for a whole page of battles up front — only for
 * the one row an admin actually opens, matching the Active-Timeframe-Only
 * convention for expensive/external work behind collapsed UI.
 */
export async function revealBattleEosVerification(
  battleId: string,
): Promise<BattleEosVerification | null> {
  await requirePageAccess("/system/eos-verification");

  const detail = await getBattleEosBlockHash(battleId);
  if (!detail) return null;

  const blockHistory = detail.eosBlockHash
    ? await verifyEosBlockWithHistory(detail.eosBlockHash)
    : null;

  return {
    eosBlockHash: detail.eosBlockHash,
    blockHistory,
  };
}

export type BlockSimulationResult =
  | { status: "error"; error: string }
  | {
      status: "ok";
      outcome: SimulatedBattleOutcome;
      /** creatorWon for THIS candidate block, same House-POV semantics as `EosBattleSummary.creatorWon`. */
      creatorWon: boolean | null;
    };

/**
 * Recomputes what a battle's outcome WOULD have been if `blockHash` (one of
 * the 5 blocks shown on the row — the real one or one of the 4 before it)
 * had been the battle's `eos_block_hash`, using the battle's REAL server
 * seed, participants, mode, and packs. Backend derives every battle client
 * seed from the block hash (`${blockHash}:${participantId}[...]`), so
 * swapping the hash and replaying the same deterministic math is enough to
 * answer "would the same side have won" — no backend call needed, decrypt
 * happens with the local SERVER_SEED_PEPPER copy only, and the plaintext
 * seed never leaves this function.
 */
export async function simulateBattleOutcomeForBlock(
  battleId: string,
  blockHash: string,
): Promise<BlockSimulationResult> {
  await requirePageAccess("/system/eos-verification");

  const pepper = process.env.PEPPER;
  if (!pepper) {
    return { status: "error", error: "PEPPER env var is not configured." };
  }

  const context = await getBattleSimulationContext(battleId);
  if (!context) return { status: "error", error: "Battle not found." };
  if (context.rounds.length === 0) {
    return { status: "error", error: "No pack data available to simulate this battle." };
  }

  let serverSeed: string;
  try {
    serverSeed = decryptServerSeed(context.serverSeedEncrypted, pepper);
  } catch {
    return { status: "error", error: "Failed to decrypt this battle's server seed — wrong pepper?" };
  }

  const outcome = simulateBattleOutcomeForBlockHash({
    mode: context.mode,
    battleId,
    blockHash,
    serverSeed,
    isCrazyMode: context.isCrazyMode,
    participants: context.participants,
    rounds: context.rounds,
  });

  const creatorWon =
    context.creatorTeam !== null && outcome.winnerTeam !== null
      ? context.creatorTeam === outcome.winnerTeam
      : null;

  return { status: "ok", outcome, creatorWon };
}
