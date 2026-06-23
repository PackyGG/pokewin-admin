"use server";

import { revalidateTag } from "next/cache";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getPacksPoolComposition } from "@/lib/queries/packs";
import { computePackRiskFromAggregates } from "@/app/(admin)/insights/edge-calc/risk";
import {
  PACK_STUDIO_CASH_PACK_TYPES,
  buildPackCompliance,
  readMaxWinCap,
  autoTargetEdge,
  readEdgeCurveConfig,
} from "@/app/(admin)/packs/_lib/risk-config";

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
  // Resolve the per-pack edge-curve config ONCE up-front (mirrors `readMaxWinCap`)
  // so every pack's `belowTargetEdge` flag is checked against ITS OWN curve target
  // — `autoTargetEdge({price, maxWin}, edgeCurveCfg)` — not the flat 10.99% floor.
  const edgeCurveCfg = await readEdgeCurveConfig();

  // ── Resolve in-scope pack ids (active cash packs) from MAIN, read-only ──
  // Active `official` cash packs (`PACK_STUDIO_CASH_PACK_TYPES`). We resolve the
  // id set here, then feed it to the SAME scalable aggregate path via the
  // `packIds` overload. The `packs` table is small (~hundreds of rows) so this
  // filtered id read is a cheap seq scan (the planner declines an index at
  // this cardinality — verified read-only EXPLAIN), matching the Foundation's
  // own composition query.
  const db = await getDb();
  // SAFETY INVARIANT: `included` is built ONLY from `PACK_STUDIO_CASH_PACK_TYPES`,
  // a hardcoded module constant of trusted string literals — never user input.
  // This is the ONLY reason interpolating it into `$queryRawUnsafe` is safe. If
  // this list is ever made dynamic/settings-derived, this becomes a SQL-injection
  // vector with no compiler signal — switch to a parameterized `pack_type = ANY($1)`
  // bind before doing so.
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
    // Bust the Pack Studio Doctor + Overview caches so the post-snapshot
    // refresh reflects current state (mirrors applyPackRetune /
    // refreshPackRiskScore). Harmless when no rows changed.
    revalidateTag("pack-studio-overview");
    return { count: 0, computedAt: new Date().toISOString() };
  }

  // Scalable aggregate composition (grouped SQL sums — no per-card fetch).
  const compositions = await getPacksPoolComposition({ packIds });

  const computedAt = new Date();

  // Score every pack first (pure math, no DB I/O) so the transaction below
  // only holds the connection for the DB writes, not the CPU work.
  const scoredRows = compositions.map((c) => {
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

    return {
      pack_id: c.id,
      edge: risk.edge,
      cv: risk.cv,
      win_rate: risk.winRate,
      near_miss: risk.nearMiss,
      max_win: risk.maxWin,
      max_mult: risk.maxMult,
      risk_score: risk.riskScore0to100,
      tier: risk.tier,
      // `buildPackCompliance` derives every flag except `belowTargetEdge` from the
      // pack's own risk; it uses the flat floor for that one. Override it here with
      // the PER-PACK curve target so a pack is "below target" only when it falls
      // below ITS OWN `autoTargetEdge(price, maxWin)` — not the flat 10.99% floor.
      compliance: {
        ...buildPackCompliance(risk, maxWinCap),
        belowTargetEdge:
          risk.edge <
          autoTargetEdge(
            { price: c.price, maxWin: risk.maxWin },
            edgeCurveCfg,
          ),
      },
      computed_at: computedAt,
    };
  });

  // Commit every upsert in a SINGLE atomic transaction (a single bad pack
  // rolls the whole batch back rather than leaving a half-written snapshot).
  //
  // ⚠️ This is an *interactive* transaction, NOT one network round-trip:
  // Prisma runs the N upserts sequentially inside one DB transaction, so the
  // wall-clock cost is ~N × (round-trip to the remote ADMIN DB). Prisma's
  // DEFAULT interactive-transaction timeout is 5000 ms — and on Vercel
  // serverless (cold connection pool + remote ADMIN DB latency) scoring every
  // active cash pack blew past it, producing a `P2028` ("rollback cannot be
  // executed on an expired transaction") that crashed the snapshot render
  // (captured in production: ~5257 ms > 5000 ms). The interactive (callback)
  // form is required because the batch/array form does NOT accept `timeout`.
  // The raised `timeout`/`maxWait` give the batch room to finish; the route's
  // `maxDuration` (see ../doctor/page.tsx) gives the underlying serverless
  // function matching budget so we never trade one timeout for another.
  await adminDb.$transaction(
    async (tx) => {
      for (const { pack_id, ...row } of scoredRows) {
        await tx.pack_risk_scores.upsert({
          where: { pack_id },
          update: row,
          create: { pack_id, ...row },
        });
      }
    },
    {
      // Raise the ceiling well above Prisma's 5s default so the batch can't
      // trip P2028. `maxWait` is how long Prisma waits to acquire a pooled
      // connection before starting the tx.
      timeout: 120_000,
      maxWait: 15_000,
    },
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "pack_risk_snapshot",
    metadata: { count: compositions.length },
  });

  // Bust the Pack Studio Doctor + Overview caches (tag "pack-studio-overview",
  // 60s revalidate) so the post-snapshot router.refresh() reads the fresh rows
  // immediately instead of stale cached scores. Mirrors applyPackRetune /
  // refreshPackRiskScore.
  revalidateTag("pack-studio-overview");

  return { count: compositions.length, computedAt: computedAt.toISOString() };
}
