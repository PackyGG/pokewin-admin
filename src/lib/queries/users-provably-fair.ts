import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";

const GAME_TYPES = new Set([
  "pack",
  "battle",
  "upgrader",
  "battle_double_down",
  "keno",
]);

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
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));
  const params: unknown[] = [userId];
  const predicates = [`gs.user_id = $1`];
  if (
    filters?.gameType &&
    filters.gameType !== "all" &&
    GAME_TYPES.has(filters.gameType)
  ) {
    params.push(filters.gameType);
    predicates.push(`gs.game_type = $${params.length}::game_type`);
  }
  const search = filters?.search?.trim();
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
    const searchParam = params.length;
    const ticket = Number.parseInt(search, 10);
    if (Number.isFinite(ticket)) params.push(ticket);
    predicates.push(`(
      pfr.result_hash ILIKE $${searchParam} ESCAPE '\\'
      OR pfr.server_seed_hash ILIKE $${searchParam} ESCAPE '\\'
      OR pfr.client_seed ILIKE $${searchParam} ESCAPE '\\'
      ${Number.isFinite(ticket) ? `OR pfr.ticket = $${params.length}` : ""}
    )`);
  }
  const where = predicates.join(" AND ");

  const [items, total] = await Promise.all([
    queryMainRows<{
      id: string; client_seed: string; server_seed_hash: string;
      server_seed: string | null; nonce: number; cursor: number; ticket: number;
      result_hash: string; result_metadata: unknown; game_type: string;
      battle_id: string | null; value_at_obtained: string | null; created_at: Date | string;
    }[]>(
      `SELECT pfr.id, pfr.client_seed, pfr.server_seed_hash, pfr.server_seed,
              pfr.nonce, pfr.cursor, pfr.ticket, pfr.result_hash,
              pfr.result_metadata, gs.game_type::text AS game_type,
              pfr.battle_id, ui.value_at_obtained::text AS value_at_obtained,
              pfr.created_at
         FROM provably_fair_results pfr
         JOIN game_sessions gs ON gs.id = pfr.game_session_id
         LEFT JOIN user_inventory ui ON ui.id = pfr.inventory_item_id
        WHERE ${where}
        ORDER BY pfr.created_at DESC
        LIMIT ${safePerPage} OFFSET ${(safePage - 1) * safePerPage}`,
      ...params,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
         FROM provably_fair_results pfr
         JOIN game_sessions gs ON gs.id = pfr.game_session_id
        WHERE ${where}`,
      ...params,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
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
      gameType: r.game_type,
      battleId: r.battle_id,
      cardName: null,
      cardValue: r.value_at_obtained === null ? null : toNumber(r.value_at_obtained),
      createdAt: new Date(r.created_at).toISOString(),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
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
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 10));

  const [items, total] = await Promise.all([
    queryMainRows<{
      id: string; old_client_seed: string; old_server_seed: string;
      old_server_seed_hash: string; old_nonce: number; new_client_seed: string;
      new_server_seed_hash: string; rotated_at: Date | string;
    }[]>(
      `SELECT id, old_client_seed, old_server_seed, old_server_seed_hash,
              old_nonce, new_client_seed, new_server_seed_hash, rotated_at
         FROM seed_rotation_history
        WHERE user_id = $1
        ORDER BY rotated_at DESC
        LIMIT ${safePerPage} OFFSET ${(safePage - 1) * safePerPage}`,
      userId,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
         FROM seed_rotation_history WHERE user_id = $1`,
      userId,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
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
      rotatedAt: new Date(r.rotated_at).toISOString(),
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}
