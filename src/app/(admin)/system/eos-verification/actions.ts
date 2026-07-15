"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getBattleParticipantsForVerification,
  type EosParticipant,
} from "@/lib/queries/eos-verification";
import {
  verifyEosBlockAcrossEndpoints,
  type EosEndpointCheck,
} from "@/lib/eos/verify";

export type BattleEosVerification = {
  eosBlockHash: string | null;
  participants: EosParticipant[];
  endpointChecks: EosEndpointCheck[];
};

/**
 * On-demand (row-expand only) fetch of a battle's participants + a live
 * cross-check of its stored `eos_block_hash` against all 13 public EOS RPC
 * providers. Never called for a whole page of battles up front — only for
 * the one row an admin actually opens, matching the Active-Timeframe-Only
 * convention for expensive/external work behind collapsed UI.
 */
export async function revealBattleEosVerification(
  battleId: string,
): Promise<BattleEosVerification | null> {
  await requirePageAccess("/system/eos-verification");

  const detail = await getBattleParticipantsForVerification(battleId);
  if (!detail) return null;

  const endpointChecks = detail.eosBlockHash
    ? await verifyEosBlockAcrossEndpoints(detail.eosBlockHash)
    : [];

  return {
    eosBlockHash: detail.eosBlockHash,
    participants: detail.participants,
    endpointChecks,
  };
}
