"use server";

import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getPacksPoolComposition } from "@/lib/queries/packs";
import {
  computePackRiskFromAggregates,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  PACK_STUDIO_CASH_PACK_TYPES,
  TARGET_PACK_EDGE,
  ZERO_NEAR_MISS_FLOOR,
  readMaxWinCap,
  type PackComplianceFlags,
} from "../_lib/risk-config";

/**
 * Result of a successful snapshot run — surfaced back to the operator UI.
 */
export type SnapshotResult = {
  /** How many packs were scored + upserted this run. */
  count: number;
  /** ISO timestamp the snapshot completed (server clock). */
  computedAt: string;
};

/**
 * Build the per-pack compliance flag payload persisted in `pack_risk_scores.compliance`.
 * House-edge target + the win-cap come from `admin_settings.pack_system_config`
 * (cap resolved by `readMaxWinCap`, default 25000); everything else is derived
 * from the computed {@link PackRisk}.
 */
function buildCompliance(risk: PackRisk, maxWinCap: number): PackComplianceFlags {
  return {
    belowTargetEdge: risk.edge < TARGET_PACK_EDGE,
    overMaxWinCap: risk.maxWin > maxWinCap,
    zeroNearMiss: risk.nearMiss < ZERO_NEAR_MISS_FLOOR,
    overTier: risk.tier === "T5",
  };
}

/**
 * Score EVERY active cash pack (official) and persist one risk row per pack into
 * the ADMIN DB.
 *
 * Data flow (respects the strict dual-DB boundary):
 *   • READS the MAIN game DB read-only — a tiny `id` SELECT for active cash
 *     packs, then the SCALABLE aggregate composition via
 *     `getPacksPoolComposition({ packIds })` (grouped SQL sums; never fetches
 *     each card row of each pack).
 *   • Maps each aggregate row through `computePackRiskFromAggregates` (the same
 *     pure engine the Edge Calc surface uses).
 *   • WRITES only the ADMIN DB: upserts `pack_risk_scores` (one row per pack)
 *     and an `admin_audit_events` entry. No MAIN writes.
 *
 * Authorization: gated by `requirePackStudioAccess` (owner OR a role whose
 * ADMIN-DB Pack-Studio toggle is on) — throws on denial so the calling UI can
 * surface a toast.
 *
 * The win-cap used for the `overMaxWinCap` flag is read once up-front from
 * `admin_settings.pack_system_config` (default 25000).
 */
export async function snapshotPackRisk(): Promise<SnapshotResult> {
  const session = await requirePackStudioAccess(
    "Not authorized to run the pack-risk snapshot.",
  );

  const maxWinCap = await readMaxWinCap();

  // ── Resolve in-scope pack ids (active cash packs) from MAIN, read-only ──
  // Active `official` cash packs (`PACK_STUDIO_CASH_PACK_TYPES`). We resolve the
  // id set here, then feed it to the SAME scalable aggregate path via the
  // `packIds` overload. The `packs` table is small (~hundreds of rows) so this
  // filtered id read is a cheap seq scan (the planner declines an index at
  // this cardinality — verified read-only EXPLAIN), matching the Foundation's
  // own composition query.
  const db = await getDb();
  const included = PACK_STUDIO_CASH_PACK_TYPES.map((t) => `'${t}'`).join(", ");
  const idRows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM packs
     WHERE pack_type IN (${included}) AND price > 0 AND active = true`,
  );
  const packIds = idRows.map((r) => r.id);

  if (packIds.length === 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "pack_risk_snapshot",
      metadata: { count: 0 },
    });
    return { count: 0, computedAt: new Date().toISOString() };
  }

  // Scalable aggregate composition (grouped SQL sums — no per-card fetch).
  const compositions = await getPacksPoolComposition({ packIds });

  const computedAt = new Date();

  // Build one upsert per pack, then commit them in a SINGLE batched
  // round-trip. The previous version awaited each upsert sequentially —
  // ~one network round-trip per pack to the remote ADMIN DB — which, across
  // every active cash pack, could exceed the serverless function budget and
  // surface to the operator as a "timed out" snapshot. `$transaction([...])`
  // sends the whole batch in one round-trip (and is atomic: a single bad
  // pack rolls the batch back rather than leaving a half-written snapshot).
  const upserts = compositions.map((c) => {
    const risk = computePackRiskFromAggregates({
      price: c.price,
      totalWeight: c.totalWeight,
      weightedPriceSum: c.weightedPriceSum,
      weightedSqSum: c.weightedSqSum,
      winWeight: c.winWeight,
      nearMissWeight: c.nearMissWeight,
      maxValue: c.maxValue,
      floorValue: c.floorValue,
    });

    const row = {
      edge: risk.edge,
      cv: risk.cv,
      win_rate: risk.winRate,
      near_miss: risk.nearMiss,
      max_win: risk.maxWin,
      max_mult: risk.maxMult,
      risk_score: risk.riskScore0to100,
      tier: risk.tier,
      compliance: buildCompliance(risk, maxWinCap),
      computed_at: computedAt,
    };

    return adminDb.pack_risk_scores.upsert({
      where: { pack_id: c.id },
      update: row,
      create: { pack_id: c.id, ...row },
    });
  });

  await adminDb.$transaction(upserts);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_risk_snapshot",
    metadata: { count: compositions.length },
  });

  return { count: compositions.length, computedAt: computedAt.toISOString() };
}
