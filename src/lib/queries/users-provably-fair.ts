import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { Prisma } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Provably Fair
// ---------------------------------------------------------------------------

export type ProvablyFairResultItem = {
  id: string;
  clientSeed: string;
  serverSeedHash: string;
  serverSeed: string | null;
  nonce: number;
  cursor: number;
  ticket: number;
  resultHash: string;
  resultMetadata: unknown;
  gameType: string;
  battleId: string | null;
  cardName: string | null;
  cardValue: number | null;
  createdAt: string;
};

export async function getProvablyFairResults(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { search?: string; gameType?: string }
) {
  const db = await getDb();
  const where: Prisma.provably_fair_resultsWhereInput = {
    game_sessions: { user_id: userId },
  };

  if (filters?.gameType && filters.gameType !== "all") {
    where.game_sessions = {
      ...(where.game_sessions as object),
      game_type: filters.gameType as Prisma.Enumgame_typeFilter["equals"],
    };
  }

  if (filters?.search) {
    const s = filters.search;
    const asInt = parseInt(s, 10);
    where.OR = [
      { result_hash: { contains: s, mode: "insensitive" } },
      { server_seed_hash: { contains: s, mode: "insensitive" } },
      { client_seed: { contains: s, mode: "insensitive" } },
      ...(Number.isFinite(asInt) ? [{ ticket: asInt }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    db.provably_fair_results.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        game_sessions: { select: { game_type: true } },
        user_inventory: {
          select: {
            value_at_obtained: true,
          },
        },
      },
    }),
    db.provably_fair_results.count({ where }),
  ]);

  return {
    data: items.map((r): ProvablyFairResultItem => ({
      id: r.id,
      clientSeed: r.client_seed,
      serverSeedHash: r.server_seed_hash,
      serverSeed: r.server_seed,
      nonce: r.nonce,
      cursor: r.cursor,
      ticket: r.ticket,
      resultHash: r.result_hash,
      resultMetadata: r.result_metadata,
      gameType: r.game_sessions.game_type,
      battleId: r.battle_id,
      cardName: null,
      cardValue: r.user_inventory ? toNumber(r.user_inventory.value_at_obtained) : null,
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export type SeedRotationItem = {
  id: string;
  oldClientSeed: string;
  oldServerSeed: string;
  oldServerSeedHash: string;
  oldNonce: number;
  newClientSeed: string;
  newServerSeedHash: string;
  rotatedAt: string;
};

export async function getSeedRotationHistory(
  userId: string,
  page: number = 1,
  perPage: number = 10
) {
  const db = await getDb();
  const where: Prisma.seed_rotation_historyWhereInput = { user_id: userId };

  const [items, total] = await Promise.all([
    db.seed_rotation_history.findMany({
      where,
      orderBy: { rotated_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.seed_rotation_history.count({ where }),
  ]);

  return {
    data: items.map((r): SeedRotationItem => ({
      id: r.id,
      oldClientSeed: r.old_client_seed,
      oldServerSeed: r.old_server_seed,
      oldServerSeedHash: r.old_server_seed_hash,
      oldNonce: r.old_nonce,
      newClientSeed: r.new_client_seed,
      newServerSeedHash: r.new_server_seed_hash,
      rotatedAt: r.rotated_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
