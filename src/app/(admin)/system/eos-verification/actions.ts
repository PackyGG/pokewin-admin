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
import type { BattleSimulationContext } from "@/lib/queries/eos-verification";

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
      /** USD profit the creator would walk away with if their team wins — (pot share − stake), borrow-adjusted exactly like settlement.service.ts's `calculateBorrowFactor`. Null unless `creatorWon === true`. */
      creatorProfitUsd: number | null;
    };

/** Mirrors settlement.service.ts's `calculateBorrowFactor` — the house-fronted share of a borrowed stake belongs to the house, not the player. */
function calculateBorrowFactor(borrowPercentage: number): number {
  return borrowPercentage > 0 ? 1 - borrowPercentage / 100 : 1;
}

/**
 * Shared fetch-context + decrypt-seed step for both the single-block and
 * "solve all" actions, so a 5-block "solve all" only hits the DB and runs
 * the decrypt ONCE instead of 5 times — the context and server seed are
 * identical for every candidate block of the same battle.
 */
async function loadDecryptedSimContext(
  battleId: string,
): Promise<{ context: BattleSimulationContext; serverSeed: string } | { error: string }> {
  const pepper = process.env.PEPPER;
  if (!pepper) return { error: "PEPPER env var is not configured." };

  const context = await getBattleSimulationContext(battleId);
  if (!context) return { error: "Battle not found." };
  if (context.rounds.length === 0) {
    return { error: "No pack data available to simulate this battle." };
  }

  try {
    const serverSeed = decryptServerSeed(context.serverSeedEncrypted, pepper);
    return { context, serverSeed };
  } catch {
    return { error: "Failed to decrypt this battle's server seed — wrong pepper?" };
  }
}

function simulateWithContext(
  context: BattleSimulationContext,
  serverSeed: string,
  blockHash: string,
): Extract<BlockSimulationResult, { status: "ok" }> {
  const outcome = simulateBattleOutcomeForBlockHash({
    mode: context.mode,
    battleId: context.battleId,
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

  // settlement.service.ts: expectedValuePerMember = totalValue / allWinningTeamMembers.length
  // (bots included in the split), then borrow-adjusted per member. Profit is
  // that borrow-adjusted payout minus the borrow-adjusted stake actually put
  // in — i.e. `-instantLoss` from the winner's XP bookkeeping, sign-flipped.
  const creatorProfitUsd =
    creatorWon && outcome.winningTeamSize
      ? calculateBorrowFactor(context.creatorBorrowPercentage) *
        (outcome.potValueUsd / outcome.winningTeamSize - context.betAmountUsd)
      : null;

  return { status: "ok", outcome, creatorWon, creatorProfitUsd };
}

/**
 * Recomputes what a battle's outcome WOULD have been if `blockHash` (one of
 * the 5 blocks shown on the row — the real one or one of the 4 before it)
 * had been the battle's `eos_block_hash`, using the battle's REAL server
 * seed, participants, mode, and packs. Backend derives every battle client
 * seed from the block hash alone (`${blockHash}:${participantId}` — round
 * and card index only vary the nonce/cursor, never the seed string), so
 * swapping the hash and replaying the same deterministic math is enough to
 * answer "would the same side have won" — no backend call needed, decrypt
 * happens with the local PEPPER copy only, and the plaintext seed never
 * leaves this function.
 */
export async function simulateBattleOutcomeForBlock(
  battleId: string,
  blockHash: string,
): Promise<BlockSimulationResult> {
  await requirePageAccess("/system/eos-verification");

  const loaded = await loadDecryptedSimContext(battleId);
  if ("error" in loaded) return { status: "error", error: loaded.error };

  return simulateWithContext(loaded.context, loaded.serverSeed, blockHash);
}

/**
 * Same simulation as `simulateBattleOutcomeForBlock`, but for every block on
 * the row in one call ("Solve all") — one DB fetch + one decrypt shared
 * across all candidate blocks instead of one round-trip per block.
 */
export async function simulateAllBlockOutcomes(
  battleId: string,
  blocks: { blockNum: number; blockHash: string }[],
): Promise<Record<number, BlockSimulationResult>> {
  await requirePageAccess("/system/eos-verification");

  const loaded = await loadDecryptedSimContext(battleId);
  if ("error" in loaded) {
    const errorResult: BlockSimulationResult = { status: "error", error: loaded.error };
    return Object.fromEntries(blocks.map((b) => [b.blockNum, errorResult]));
  }

  return Object.fromEntries(
    blocks.map((b) => [b.blockNum, simulateWithContext(loaded.context, loaded.serverSeed, b.blockHash)]),
  );
}
