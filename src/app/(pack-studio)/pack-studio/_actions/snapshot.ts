"use server";

import { pgArrayParam } from "@/lib/drizzle-array-param";
import { revalidateTag } from "next/cache";
import { sql } from "drizzle-orm";
import { requirePackStudioAccess } from "@/lib/require-pack-studio-access";
import { adminDrizzle } from "@/lib/admin-db";
import { getReadDrizzleDb } from "@/lib/db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getPacksPoolComposition } from "@/lib/queries/packs";
import { computePackRiskFromAggregates } from "@/app/(admin)/insights/edge-calc/risk";
import {
  PACK_STUDIO_CASH_PACK_TYPES,
  buildPackCompliance,
  readMaxWinCap,
  autoTargetEdge,
  readEdgeCurveConfig,
  resolveIntendedHitRate,
} from "@/app/(admin)/packs/_lib/risk-config";

// NOTE: `export const maxDuration = …` is NOT valid in a `"use server"` file —
// only async functions may be exported. The function budget for this action
// comes from the calling route segment (`../doctor/page.tsx` sets
// `maxDuration = 120`). Don't add a top-level `maxDuration` export here.

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
  const db = await getReadDrizzleDb();
  // SAFETY INVARIANT: `included` is built ONLY from `PACK_STUDIO_CASH_PACK_TYPES`,
  // a hardcoded module constant of trusted string literals — never user input.
  // The current query still binds the resulting array. If this list ever
  // becomes settings-derived, keep it parameterized as `pack_type = ANY($1)`
  // bind before doing so.
  const idResult = await db.execute<{ id: string }>(sql`
    SELECT id
    FROM packs
    WHERE pack_type::text = ANY(${pgArrayParam([...PACK_STUDIO_CASH_PACK_TYPES])}::text[])
      AND price > 0
      AND active = true
  `);
  const packIds = idResult.rows.map((r) => r.id);

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
      // TAGGED packs (DB tags first, name-prefix fallback) are binary lottery
      // products — zero near-miss is the genre, so `zeroNearMiss` never flags.
      compliance: {
        ...buildPackCompliance(risk, maxWinCap, {
          tagged: resolveIntendedHitRate(c.name, c.tags) !== null,
        }),
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

  // Commit every score row in a SINGLE round-trip via `INSERT … ON CONFLICT
  // (pack_id) DO UPDATE` — atomic by definition (one statement), no client-side
  // transaction overhead, no interactive-transaction timeout to trip.
  //
  // The history of this loop is a chain of timeouts the previous shapes kept
  // hitting on Vercel serverless against the remote ADMIN DB:
  //   1) Sequential `await upsert(...)` → ~one network round-trip per pack.
  //      With ~180 active cash packs and ~50–100ms RTT from a cold serverless
  //      pool, the cumulative wall-clock outran the platform's default
  //      function budget and surfaced as a "timed out" snapshot.
  //   2) An array of individual upserts still created avoidable statement
  //      overhead and offered no useful timeout control.
  //   3) A loop inside an interactive transaction returned to N round-trips
  //      and could hit the transaction timeout in production.
  //      (~5257ms > 5000ms), which surfaced as the user-visible
  //      "An error occurred in the Server Components render" digest.
  //
  // The right shape is the one Postgres was built for: a multi-row `INSERT`
  // with `ON CONFLICT (pack_id) DO UPDATE` and parameter arrays. ONE
  // statement, ONE round-trip, ONE connection slot — independent of N.
  // No wrapper transaction or per-row timeout knobs are needed.
  //
  // The `array_length` defensive bail-out is unreachable in practice
  // (we already returned at `packIds.length === 0` above), but guards
  // against a future caller path that could pass an empty `scoredRows`.
  if (scoredRows.length > 0) {
    const packIdArr = scoredRows.map((r) => r.pack_id);
    const edgeArr = scoredRows.map((r) => r.edge);
    const cvArr = scoredRows.map((r) => r.cv);
    const winRateArr = scoredRows.map((r) => r.win_rate);
    const nearMissArr = scoredRows.map((r) => r.near_miss);
    const maxWinArr = scoredRows.map((r) => r.max_win);
    const maxMultArr = scoredRows.map((r) => r.max_mult);
    const riskScoreArr = scoredRows.map((r) => r.risk_score);
    const tierArr = scoredRows.map((r) => r.tier);
    // `compliance` is a JSON column; serialize each row's flag object to a
    // JSON string and let `unnest(... text[])` + `::jsonb` cast on insert do
    // the rest. Avoids any per-row `Json` typing dance.
    const complianceArr = scoredRows.map((r) => JSON.stringify(r.compliance));

    await adminDrizzle.execute(sql`
      INSERT INTO pack_risk_scores (
        pack_id, edge, cv, win_rate, near_miss, max_win, max_mult,
        risk_score, tier, compliance, computed_at
      )
      SELECT
        unnest(${pgArrayParam(packIdArr)}::text[]),
        unnest(${pgArrayParam(edgeArr)}::numeric[]),
        unnest(${pgArrayParam(cvArr)}::numeric[]),
        unnest(${pgArrayParam(winRateArr)}::numeric[]),
        unnest(${pgArrayParam(nearMissArr)}::numeric[]),
        unnest(${pgArrayParam(maxWinArr)}::numeric[]),
        unnest(${pgArrayParam(maxMultArr)}::numeric[]),
        unnest(${pgArrayParam(riskScoreArr)}::int[]),
        unnest(${pgArrayParam(tierArr)}::text[]),
        unnest(${pgArrayParam(complianceArr)}::text[])::jsonb,
        ${computedAt}::timestamptz
      ON CONFLICT (pack_id) DO UPDATE SET
        edge        = EXCLUDED.edge,
        cv          = EXCLUDED.cv,
        win_rate    = EXCLUDED.win_rate,
        near_miss   = EXCLUDED.near_miss,
        max_win     = EXCLUDED.max_win,
        max_mult    = EXCLUDED.max_mult,
        risk_score  = EXCLUDED.risk_score,
        tier        = EXCLUDED.tier,
        compliance  = EXCLUDED.compliance,
        computed_at = EXCLUDED.computed_at
    `);
  }

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
