import { pgArrayParam } from "@/lib/drizzle-array-param";
import { sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { logError } from "@/lib/errors/logger";
import {
  resolveUpgraderMetadata,
  upgraderTargetMultiplierSql,
  type UpgraderMetadata,
} from "@/lib/utils/upgrader-metadata";

/** Row returned by the batch upgrader-target lookup for ledger tx ids. */
export type UpgraderTargetBatchRow = {
  ledger_tx_id: string;
  gsid: string | null;
  won_amount: string | null;
  /** Full `upgrader_games` row — catches schema drift (e.g. typed multiplier cols). */
  upgrader_game: unknown;
  /** Full `game_sessions` row for the resolved upgrader session. */
  game_session: unknown;
  /** Best PF metadata blob (prefers rows with a parsed target multiplier). */
  pf_metadata: unknown;
  /** Every PF metadata blob across all sessions linked to this bet. */
  pf_metadata_all: unknown[] | null;
  ledger_metadata: unknown;
  /** Target multiplier extracted in SQL from PF + ledger + upgrader_games JSON. */
  sql_target_multiplier: string | null;
};

function upgraderGameTargetSql(ugAlias: string): string {
  const j = `to_jsonb(${ugAlias})`;
  return `COALESCE(
        NULLIF(${j}->>'target_multiplier', '')::numeric,
        NULLIF(${j}->>'targetMultiplier', '')::numeric,
        NULLIF(${j}->>'multiplier', '')::numeric,
        NULLIF(${j}->>'selected_multiplier', '')::numeric,
        NULLIF(${j}->>'selectedMultiplier', '')::numeric,
        NULLIF(${j}->>'upgrade_multiplier', '')::numeric,
        NULLIF(${j}->>'desired_multiplier', '')::numeric
      )`;
}

/**
 * Batch-resolve upgrader play configuration for `upgrader_bet` ledger rows.
 *
 * Session link priority (owner-reported data lives on `game_sessions`):
 *   1. `game_sessions.bet_ledger_tx_id = ledger_transactions.id` (canonical)
 *   2. `ledger_transactions.game_session_id` (fallback)
 *
 * PF metadata is aggregated across EVERY upgrader session tied to the bet
 * so we don't miss the blob when the ledger FK points at a stale session.
 */
export async function fetchUpgraderTargetByLedgerTxIds(
  ledgerTxIds: string[],
): Promise<Map<string, UpgraderTargetBatchRow>> {
  const out = new Map<string, UpgraderTargetBatchRow>();
  if (ledgerTxIds.length === 0) return out;

  const pfTargetExpr = upgraderTargetMultiplierSql("pf.result_metadata");
  const ltTargetExpr = upgraderTargetMultiplierSql("lt.metadata");
  const ugTargetExpr = upgraderGameTargetSql("ug");

  try {
    const db = await getReadDrizzleDb();
    const result = await db.execute<UpgraderTargetBatchRow>(sql`
       SELECT lt.id::text AS ledger_tx_id,
              gs.id::text AS gsid,
              ug.won_amount::text AS won_amount,
              to_jsonb(ug) AS upgrader_game,
              to_jsonb(gs) AS game_session,
              pf.best_metadata AS pf_metadata,
              pf.all_metadata AS pf_metadata_all,
              lt.metadata AS ledger_metadata,
              COALESCE(
                pf.best_target,
                ${sql.raw(ltTargetExpr)},
                ${sql.raw(ugTargetExpr)}
              )::text AS sql_target_multiplier
       FROM unnest(${pgArrayParam(ledgerTxIds)}::uuid[]) AS bet_id(id)
       JOIN ledger_transactions lt ON lt.id = bet_id.id
       LEFT JOIN LATERAL (
         SELECT gs_inner.*
         FROM game_sessions gs_inner
         WHERE gs_inner.game_type::text = 'upgrader'
           AND (
             gs_inner.bet_ledger_tx_id = lt.id
             OR gs_inner.id = lt.game_session_id
           )
         ORDER BY
           CASE WHEN gs_inner.bet_ledger_tx_id = lt.id THEN 0 ELSE 1 END,
           gs_inner.created_at DESC
         LIMIT 1
       ) gs ON true
       LEFT JOIN upgrader_games ug ON ug.id = gs.game_id
       LEFT JOIN LATERAL (
         SELECT
           (array_agg(pf.result_metadata ORDER BY
             CASE WHEN ${sql.raw(pfTargetExpr)} IS NOT NULL THEN 0 ELSE 1 END,
             pf.cursor ASC
           ))[1] AS best_metadata,
           COALESCE(
             jsonb_agg(pf.result_metadata ORDER BY pf.cursor ASC)
               FILTER (WHERE pf.result_metadata IS NOT NULL),
             '[]'::jsonb
           ) AS all_metadata,
           MAX(${sql.raw(pfTargetExpr)}) AS best_target
         FROM provably_fair_results pf
         WHERE pf.game_session_id IN (
           SELECT gs2.id
           FROM game_sessions gs2
           WHERE gs2.game_type::text = 'upgrader'
             AND (
               gs2.bet_ledger_tx_id = lt.id
               OR gs2.id = lt.game_session_id
               OR (gs.id IS NOT NULL AND gs2.id = gs.id)
             )
         )
       ) pf ON true
    `);

    for (const r of result.rows) {
      out.set(r.ledger_tx_id, r);
    }
  } catch (e) {
    logError(
      "upgrader.targetBatch",
      "batch lookup failed (non-fatal)",
      e,
    );
  }

  return out;
}

/** Merge a batch row and optional joined sources into display fields. */
export function resolveUpgraderTargetFromBatch(
  row: UpgraderTargetBatchRow | undefined,
  ...extraSources: unknown[]
): Pick<
  UpgraderMetadata,
  "targetMultiplier" | "targetChance" | "targetChanceDerived" | "houseEdge"
> {
  const pfAllRaw = row?.pf_metadata_all;
  const pfAll = Array.isArray(pfAllRaw)
    ? pfAllRaw
    : pfAllRaw != null && typeof pfAllRaw === "object"
      ? [pfAllRaw]
      : [];
  const sqlMult =
    row?.sql_target_multiplier != null &&
    row.sql_target_multiplier !== "" &&
    Number.isFinite(Number(row.sql_target_multiplier))
      ? Number(row.sql_target_multiplier)
      : null;

  const cfg = resolveUpgraderMetadata(
    sqlMult != null ? { target_multiplier: sqlMult } : null,
    row?.pf_metadata,
    ...pfAll,
    row?.upgrader_game,
    row?.game_session,
    row?.ledger_metadata,
    ...extraSources,
  );

  return {
    targetMultiplier: cfg.targetMultiplier,
    targetChance: cfg.targetChance,
    targetChanceDerived: cfg.targetChanceDerived,
    houseEdge: cfg.houseEdge,
  };
}
