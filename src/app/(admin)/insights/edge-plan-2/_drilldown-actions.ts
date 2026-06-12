"use server";

import { requirePageAccess } from "@/lib/dal";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { getMetricsScope } from "@/lib/metrics/scope";
import { toNumber } from "@/lib/utils/decimal";
import { ensureBalanceAdjustmentMetaSchema } from "@/lib/balance-adjustment-meta/ensure-schema";
import { logError } from "@/lib/errors/logger";
import { daysForInsightsPeriodCapped } from "@/lib/queries/insights-rewards/_period";

import { EDGE_PLAN_30D_LABEL, EDGE_PLAN_V2_PERIOD } from "./_baseline-v2";
import {
  buildNotItemizedDrilldownV2,
  detectAdjustmentReasonKeyV2,
  type NotItemizedDrilldownV2,
  type NotItemizedRowV2,
} from "./_model-v2";

/**
 * _drilldown-actions.ts — the NOT-ITEMIZED adjustments drill-down (owner
 * spec #12). Server action, LAZY: it runs ONLY when the adjustments panel's
 * NULL-category row is expanded (Active-Timeframe-Only — never on the
 * initial page render).
 *
 * Source of truth: ONE bounded MAIN-DB read over the SAME window + the SAME
 * canonical customer scope + the SAME NULL-category predicate as the
 * baseline's `scanAdjustmentBreakdown` — so the drill-down totals reconcile
 * EXACTLY with the panel's "Not itemized" bucket row.
 *
 * Field discovery (read-only probe + `adjustBalance` action, 2026-06-12):
 * legacy NULL-category rows carry the real reason in `description`
 * ("Admin adjustment: <reason>" / "Inventory removed: …") and at most a
 * `metadata.kind` ("inventory_removal"); there is no per-row admin id on
 * MAIN. The admin attribution comes from the ADMIN-DB
 * `admin_balance_adjustment_meta` table (keyed on `ledger_tx_id`),
 * cross-referenced IN CODE — never a cross-DB SQL join. Rows older than
 * that table simply have no admin attribution (rendered as "—").
 *
 * READ-ONLY: SELECTs on both DBs, nothing else. No audit event — this is a
 * read, not a mutation.
 */

/** Bounded fetch cap (probe 2026-06-12: ~300 NULL-category rows / 30d). */
const NOT_ITEMIZED_ROW_CAP = 2000;

export type NotItemizedDrilldownResult =
  | { ok: true; data: NotItemizedDrilldownV2 }
  | { ok: false; error: string };

type RawLedgerRow = {
  id: string;
  user_id: string;
  created_at: Date;
  amount: string;
  description: string | null;
  meta_kind: string | null;
};

export async function getNotItemizedAdjustmentDrilldown(): Promise<NotItemizedDrilldownResult> {
  await requirePageAccess("/insights/edge-plan-2");

  try {
    const db = await getDb();
    const scope = await getMetricsScope();
    const days = Math.max(1, daysForInsightsPeriodCapped(EDGE_PLAN_V2_PERIOD));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ONE bounded statement — same scope + predicate family as the
    // baseline's scanAdjustmentBreakdown NULL bucket (canonical customer
    // scope, creator-session exclusion, completed only, in-window,
    // adjustment_category IS NULL).
    const raw = await db.$queryRawUnsafe<RawLedgerRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT lt.id,
              lt.user_id,
              lt.created_at,
              lt.amount::numeric::text AS amount,
              lt.description,
              lt.metadata->>'kind' AS meta_kind
       FROM ledger_transactions lt
       WHERE lt.status = 'completed'
         AND lt.type::text = 'admin_balance_adjustment'
         AND lt.user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("lt.user_id", "lt.created_at")}
         AND lt.created_at >= '${since.toISOString()}'::timestamptz
         AND lt.metadata->>'adjustment_category' IS NULL
       ORDER BY lt.created_at DESC
       LIMIT ${NOT_ITEMIZED_ROW_CAP + 1}`,
    );

    const truncated = raw.length > NOT_ITEMIZED_ROW_CAP;
    const bounded = truncated ? raw.slice(0, NOT_ITEMIZED_ROW_CAP) : raw;

    // MAIN username lookup (separate query — no cross-DB join, bounded by
    // the distinct user set of the fetched rows).
    const userIds = [...new Set(bounded.map((r) => r.user_id))];
    const usernameById = new Map<string, string>();
    if (userIds.length > 0) {
      const users = await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      });
      for (const u of users) {
        if (u.username != null) usernameById.set(u.id, u.username);
      }
    }

    // ADMIN-DB cross-reference IN CODE: rich meta rows keyed on the exact
    // ledger_tx_id, then the acting admins' usernames. Best-effort — legacy
    // rows predate the meta table and simply resolve to null.
    const metaByLedgerId = new Map<
      string,
      { adminUserId: string; category: string; reason: string | null }
    >();
    const adminUsernameById = new Map<string, string>();
    try {
      await ensureBalanceAdjustmentMetaSchema();
      const metas = await adminDb.admin_balance_adjustment_meta.findMany({
        where: { ledger_tx_id: { in: bounded.map((r) => r.id) } },
        select: {
          ledger_tx_id: true,
          admin_user_id: true,
          category: true,
          reason_text: true,
        },
      });
      for (const m of metas) {
        metaByLedgerId.set(m.ledger_tx_id, {
          adminUserId: m.admin_user_id,
          category: m.category,
          reason: m.reason_text,
        });
      }
      const adminIds = [...new Set(metas.map((m) => m.admin_user_id))];
      if (adminIds.length > 0) {
        const admins = await adminDb.admin_users.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, username: true },
        });
        for (const a of admins) adminUsernameById.set(a.id, a.username);
      }
    } catch (err) {
      // Admin-side attribution is enrichment, not the money math — degrade
      // to null attribution rather than failing the whole drill-down.
      logError(
        "edge-plan-v2.not-itemized-drilldown",
        "admin-DB meta cross-reference degraded",
        err,
      );
    }

    const rows: NotItemizedRowV2[] = bounded.map((r) => {
      const meta = metaByLedgerId.get(r.id) ?? null;
      return {
        ledgerTxId: r.id,
        userId: r.user_id,
        username: usernameById.get(r.user_id) ?? null,
        createdAtIso: r.created_at.toISOString(),
        amountUsd: toNumber(r.amount),
        description: r.description,
        reasonKey: detectAdjustmentReasonKeyV2(r.description, r.meta_kind),
        adminUsername: meta ? (adminUsernameById.get(meta.adminUserId) ?? null) : null,
        adminCategory: meta?.category ?? null,
        adminReason: meta?.reason ?? null,
      };
    });

    return {
      ok: true,
      data: buildNotItemizedDrilldownV2(rows, {
        windowLabel: EDGE_PLAN_30D_LABEL,
        truncated,
      }),
    };
  } catch (err) {
    // SECURITY: never surface raw driver errors to the client.
    logError(
      "edge-plan-v2.not-itemized-drilldown",
      "drill-down fetch failed",
      err,
    );
    return {
      ok: false,
      error: "The not-itemized drill-down failed to load. Retry the expand.",
    };
  }
}
