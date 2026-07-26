import { unstable_cache } from "next/cache";
import { and, desc, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { queryMainRows } from "@/lib/drizzle-query";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_audit_events,
  admin_giveaway_actions,
  admin_users,
} from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  BALANCE_ADJ_CACHE_TAGS,
  ADJ_DESC_PREFIX,
  MANUAL_WD_DESC_PREFIX,
} from "./_shared";
import {
  officialStreamAdjustmentSqlPredicate,
  OFFICIAL_STREAM_ADJUSTMENT_CATEGORY,
} from "@/lib/balance-adjustment-categories";

/**
 * Audit-trail (forensic) lens for /insights/balance-adjustments.
 *
 * The canonical event is the main-DB ledger row
 * (`ledger_transactions.admin_balance_adjustment`). It carries the
 * target user, amount, description, and timestamp — but NOT the acting
 * admin. The acting admin lives in the admin-DB `admin_audit_events`
 * trail (see `by-admin.ts`). Per the CLAUDE.md dual-DB rule we can't SQL-
 * join the two clusters, so we:
 *
 *   1. Pull the most recent N ledger adjustment rows (main DB).
 *   2. Pull the matching window of audit events (admin DB), incl. the
 *      giveaway-actions rows which carry a clean `ledger_tx_id` FK back
 *      to the ledger row.
 *   3. Stitch admin attribution onto each ledger row IN CODE:
 *        a. exact match on ledger_tx_id (giveaway rows — reliable), then
 *        b. fuzzy match on (target_user_id, amount, |Δt| ≤ tolerance)
 *           for the general balance_adjustment / manual_withdrawal events
 *           (which carry no ledger id). Each audit event is consumed once.
 *
 * Admin attribution is therefore best-effort for the non-giveaway subset.
 * Rows we couldn't attribute show admin = null ("unknown"); the UI labels
 * that honestly rather than guessing.
 *
 * House-POV: credit (amount > 0) → rose; debit (amount < 0) → emerald.
 */

const DEFAULT_LIMIT = 200;
/** Fuzzy-match tolerance between ledger.created_at and audit.created_at. */
const MATCH_TOLERANCE_MS = 60_000;

export type AuditTrailRow = {
  ledgerTxId: string;
  createdAt: string;
  amount: number;
  /** "credit" (house gave) | "debit" (house took / manual withdrawal). */
  direction: "credit" | "debit";
  /** True when the description marks this as a manual withdrawal. */
  isManualWithdrawal: boolean;
  /** Recovered reason text (prefix stripped), or null. */
  reason: string | null;
  user: { userId: string; username: string | null };
  /** Acting admin, or null when attribution couldn't be resolved. */
  admin: { adminUserId: string; username: string | null } | null;
  /** True when admin attribution came from a clean ledger_tx_id FK. */
  attributionExact: boolean;
};

export type AuditTrail = {
  rows: AuditTrailRow[];
  /** Total adjustment rows in the window (may exceed rows.length). */
  totalInWindow: number;
  /** How many rows we successfully attributed to an admin. */
  attributedCount: number;
};

function classify(description: string | null): {
  isManualWithdrawal: boolean;
  reason: string | null;
} {
  if (!description) return { isManualWithdrawal: false, reason: null };
  if (description.startsWith(MANUAL_WD_DESC_PREFIX)) {
    // "Manual withdrawal: <reason>" or "Manual withdrawal: <reason> (total …)".
    // Strip the prefix; drop a trailing "(total $… …)" annotation.
    let rest = description.slice(MANUAL_WD_DESC_PREFIX.length).trim();
    const annotIdx = rest.lastIndexOf(" (total $");
    if (annotIdx > 0) rest = rest.slice(0, annotIdx).trim();
    return { isManualWithdrawal: true, reason: rest.length > 0 ? rest : null };
  }
  if (description.startsWith(ADJ_DESC_PREFIX)) {
    const rest = description.slice(ADJ_DESC_PREFIX.length).trim();
    return { isManualWithdrawal: false, reason: rest.length > 0 ? rest : null };
  }
  return { isManualWithdrawal: false, reason: description };
}

async function computeAuditTrail(
  period: InsightsRewardsPeriod,
  limit: number,
): Promise<AuditTrail> {
  const days = daysForInsightsPeriod(period);
  const since =
    days !== null ? new Date(Date.now() - days * 86_400_000) : undefined;

  // 1. Recent ledger adjustment rows (main DB) + total count.
  // FAKE-BALANCE: exclude official_stream adjustments from this forensic
  // feed (and its total) — owner-designated fake balance is hidden
  // everywhere. `NOT (admin_balance_adjustment AND category=official_stream)`
  // combined with the outer `type` filter leaves the non-official_stream
  // adjustments.
  const officialStreamPredicate = officialStreamAdjustmentSqlPredicate({
    typeColumn: "lt.type",
    metadataColumn: "lt.metadata",
  });
  type LedgerRow = {
    id: string;
    user_id: string;
    amount: string;
    description: string | null;
    created_at: Date;
  };
  const [ledgerRows, totalInWindow] = await Promise.all([
    queryMainRows<LedgerRow[]>(
      `SELECT lt.id, lt.user_id, lt.amount::text AS amount,
              lt.description, lt.created_at
       FROM ledger_transactions lt
       WHERE lt.type::text = 'admin_balance_adjustment'
         AND lt.status::text = 'completed'
         AND ($1::timestamptz IS NULL OR lt.created_at >= $1::timestamptz)
         AND NOT (${officialStreamPredicate})
       ORDER BY lt.created_at DESC
       LIMIT $2`,
      since ?? null,
      limit,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM ledger_transactions lt
       WHERE lt.type::text = 'admin_balance_adjustment'
         AND lt.status::text = 'completed'
         AND ($1::timestamptz IS NULL OR lt.created_at >= $1::timestamptz)
         AND NOT (${officialStreamPredicate})`,
      since ?? null,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  if (ledgerRows.length === 0) {
    return { rows: [], totalInWindow, attributedCount: 0 };
  }

  // 2a. Admin attribution — audit events (admin DB). Pull a slightly wider
  // window than the ledger slice so events straddling the boundary still
  // match. We only need id, target, amount-ish, timestamp.
  const auditSince = since
    ? new Date(since.getTime() - MATCH_TOLERANCE_MS)
    : undefined;
  const oldestLedger = ledgerRows[ledgerRows.length - 1].created_at;
  const auditLowerBound = auditSince ?? new Date(oldestLedger.getTime() - MATCH_TOLERANCE_MS);

  const [auditEvents, giveawayRows] = await Promise.all([
    adminDrizzle
      .select({
        id: admin_audit_events.id,
        admin_user_id: admin_audit_events.admin_user_id,
        target_user_id: admin_audit_events.target_user_id,
        event_type: admin_audit_events.event_type,
        metadata: admin_audit_events.metadata,
        created_at: admin_audit_events.created_at,
      })
      .from(admin_audit_events)
      .where(
        and(
          inArray(admin_audit_events.event_type, [
            "balance_adjustment",
            "manual_withdrawal_recorded",
          ]),
          isNotNull(admin_audit_events.admin_user_id),
          gte(admin_audit_events.created_at, auditLowerBound.toISOString()),
          sql`COALESCE(${admin_audit_events.metadata}->>'category', '') <> ${OFFICIAL_STREAM_ADJUSTMENT_CATEGORY}`,
        ),
      )
      .orderBy(desc(admin_audit_events.created_at))
      .limit(Math.max(limit * 3, 300)),
    // 2b. Giveaway rows carry a clean ledger_tx_id FK — the reliable path.
    adminDrizzle
      .select({
        ledger_tx_id: admin_giveaway_actions.ledger_tx_id,
        admin_user_id: admin_giveaway_actions.admin_user_id,
      })
      .from(admin_giveaway_actions)
      .where(
        inArray(
          admin_giveaway_actions.ledger_tx_id,
          ledgerRows.map((r) => r.id),
        ),
      ),
  ]);

  // Resolve usernames for both sides.
  const userIds = [...new Set(ledgerRows.map((r) => r.user_id))];
  const adminIds = [
    ...new Set([
      ...auditEvents.map((e) => e.admin_user_id).filter((x): x is string => !!x),
      ...giveawayRows.map((g) => g.admin_user_id),
    ]),
  ];
  const [users, admins] = await Promise.all([
    queryMainRows<{ id: string; username: string | null }[]>(
      `SELECT id, username
       FROM "user"
       WHERE id = ANY($1::text[])`,
      userIds,
    ),
    adminIds.length > 0
      ? adminDrizzle
          .select({ id: admin_users.id, username: admin_users.username })
          .from(admin_users)
          .where(inArray(admin_users.id, adminIds))
      : Promise.resolve([]),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u.username]));
  const adminMap = new Map(admins.map((a) => [a.id, a.username]));
  const giveawayByTx = new Map(
    giveawayRows
      .filter((g) => g.ledger_tx_id)
      .map((g) => [g.ledger_tx_id as string, g.admin_user_id]),
  );

  // Index audit events by target_user_id for the fuzzy match; track which
  // have been consumed so two ledger rows don't claim the same event.
  const consumed = new Set<string>();
  const eventsByUser = new Map<string, typeof auditEvents>();
  for (const e of auditEvents) {
    if (!e.target_user_id) continue;
    const arr = eventsByUser.get(e.target_user_id);
    if (arr) arr.push(e);
    else eventsByUser.set(e.target_user_id, [e]);
  }

  function metaAmount(e: (typeof auditEvents)[number]): number | null {
    const m = e.metadata as Record<string, unknown> | null;
    if (!m) return null;
    // balance_adjustment → amount (signed); manual_withdrawal_recorded →
    // amountUsd (positive magnitude of a debit).
    if (e.event_type === "manual_withdrawal_recorded") {
      const v = m.amountUsd;
      return typeof v === "number" ? -Math.abs(v) : null;
    }
    const v = m.amount;
    return typeof v === "number" ? v : null;
  }

  let attributedCount = 0;
  const rows: AuditTrailRow[] = ledgerRows.map((lt) => {
    const amount = toNumber(lt.amount);
    const { isManualWithdrawal, reason } = classify(lt.description);

    // a. Exact giveaway FK match.
    let adminUserId: string | null = giveawayByTx.get(lt.id) ?? null;
    // Exact only when the giveaway FK resolved it; a fuzzy match below
    // sets adminUserId but is never "exact".
    const attributionExact = adminUserId !== null;

    // b. Fuzzy match on (target_user_id, amount, |Δt|).
    if (!adminUserId) {
      const candidates = eventsByUser.get(lt.user_id);
      if (candidates) {
        const ltTime = lt.created_at.getTime();
        let best: { id: string; admin: string } | null = null;
        let bestDt = Infinity;
        for (const e of candidates) {
          if (consumed.has(e.id) || !e.admin_user_id) continue;
          const ea = metaAmount(e);
          // amount must match (within a cent for float noise).
          if (ea === null || Math.abs(ea - amount) > 0.01) continue;
          const dt = Math.abs(new Date(e.created_at).getTime() - ltTime);
          if (dt <= MATCH_TOLERANCE_MS && dt < bestDt) {
            bestDt = dt;
            best = { id: e.id, admin: e.admin_user_id };
          }
        }
        if (best) {
          consumed.add(best.id);
          adminUserId = best.admin;
        }
      }
    }

    if (adminUserId) attributedCount += 1;

    return {
      ledgerTxId: lt.id,
      createdAt: lt.created_at.toISOString(),
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      isManualWithdrawal,
      reason,
      user: { userId: lt.user_id, username: userMap.get(lt.user_id) ?? null },
      admin: adminUserId
        ? { adminUserId, username: adminMap.get(adminUserId) ?? null }
        : null,
      attributionExact,
    };
  });

  return { rows, totalInWindow, attributedCount };
}

const cached = unstable_cache(
  async (period: InsightsRewardsPeriod, limit: number) =>
    computeAuditTrail(period, limit),
  ["insights-balance-adjustments-audit-trail-v1"],
  { revalidate: 60, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

const cachedLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, limit: number) =>
    computeAuditTrail(period, limit),
  ["insights-balance-adjustments-audit-trail-lifetime-v1"],
  { revalidate: 300, tags: [...BALANCE_ADJ_CACHE_TAGS] },
);

export async function getBalanceAdjustmentAuditTrail(
  period: InsightsRewardsPeriod,
  limit = DEFAULT_LIMIT,
): Promise<AuditTrail> {
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedLifetime(period, limit)
    : cached(period, limit);
}
