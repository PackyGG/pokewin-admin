import "server-only";

import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";

/**
 * Creator Hub — Audit Spend.
 *
 * Lifetime, per-event ledger of every creator-related cost the HOUSE has
 * paid out. One spend event = one row.
 *
 * Two source systems are merged:
 *
 *   1. MAIN-DB `ledger_transactions` — fill-program legs, multiplier-deal
 *      payouts, conversion grants, deal grants, and affiliate-leaderboard
 *      prize / pool seed legs. Each row carries `metadata` with the
 *      deal_id / session_id / leaderboard_id we link out to.
 *
 *   2. ADMIN-DB `expenses` — manual creator/marketing expense rows logged
 *      by the team. Filtered to creator-facing categories.
 *
 * Reads only. MAIN is read-only (CLAUDE.md). ADMIN is the operational
 * notes/expenses DB.
 *
 * Index strategy (probed read-only against prod 2026-06-23):
 *   - `idx_ledger_tx_status_type_created_at` AND
 *     `idx_ledger_tx_created_at` BOTH exist. The planner prefers the
 *     plain created_at DESC index for this scan (~15 ms LIMIT 25,
 *     ~80 ms OFFSET 500). Both are index-served — no seq scan.
 *   - Aggregate COUNT(*) over the filter does a parallel seq scan
 *     (~100 ms). Acceptable for a lifetime audit; aggressively cached.
 */

/** All `ledger_transaction_type` values that represent a HOUSE payout to /
 *  on behalf of creators. `creator_tip` is excluded — that's a regular
 *  user-to-creator transfer (sender pays from their own balance, not
 *  ours). Direction-aware fill legs are deduped to the SENT side. */
export const HOUSE_CREATOR_COST_TX_TYPES = [
  // Affiliate leaderboard pool — house seeds + winners get paid out.
  "affiliate_leaderboard_creation",
  "affiliate_leaderboard_prize",
  // Fill program — house-funded session pot.
  "creator_fill_activation",
  "creator_fill_spend_tip",
  "creator_fill_spend_battle",
  "creator_fill_conversion",
  "creator_deal_fill_grant",
  // Multiplier-deal house contribution + settlement payouts.
  "creator_multiplier_platform_credit",
  "creator_multiplier_settlement_payout",
  "creator_multiplier_spend_tip",
  "creator_multiplier_spend_battle",
  "creator_multiplier_spend_wager",
] as const;

export type SpendTxType = (typeof HOUSE_CREATOR_COST_TX_TYPES)[number];

/** Event-type filter chips on the page. Maps a UI bucket to the set of
 *  raw `ledger_transaction_type` rows that belong to it. `expense` is a
 *  virtual source (ADMIN-DB `expenses`, not a ledger leg). */
export const SPEND_EVENT_BUCKETS = {
  all: [...HOUSE_CREATOR_COST_TX_TYPES],
  leaderboard: [
    "affiliate_leaderboard_creation",
    "affiliate_leaderboard_prize",
  ] as SpendTxType[],
  fill: [
    "creator_fill_activation",
    "creator_fill_spend_tip",
    "creator_fill_spend_battle",
    "creator_fill_conversion",
    "creator_deal_fill_grant",
  ] as SpendTxType[],
  multiplier: [
    "creator_multiplier_platform_credit",
    "creator_multiplier_settlement_payout",
    "creator_multiplier_spend_tip",
    "creator_multiplier_spend_battle",
    "creator_multiplier_spend_wager",
  ] as SpendTxType[],
} as const;

export type SpendBucketKey = keyof typeof SPEND_EVENT_BUCKETS | "expense";

export const SPEND_BUCKET_KEYS: SpendBucketKey[] = [
  "all",
  "leaderboard",
  "fill",
  "multiplier",
  "expense",
];

/** One row in the audit list. Source-agnostic so the table can render
 *  both ledger legs and admin expenses through the same component. */
export type SpendEventRow = {
  /** Stable per-source key: `ledger:<uuid>` or `expense:<uuid>`. */
  key: string;
  /** ISO instant of the event (DESC order key). */
  occurredAt: string;
  /** Event-type bucket — drives the badge color + label. */
  bucket: Exclude<SpendBucketKey, "all">;
  /** Raw `ledger_transaction_type` (for ledger rows) or "expense". */
  rawType: string;
  /** Pre-formatted USD amount, always positive. House POV — this is what
   *  WE paid out, so the table renders it rose. */
  amountUsd: number;
  /** Receiving / impacted user, if known (creator or fill recipient). */
  user: {
    id: string;
    username: string | null;
    image: string | null;
  } | null;
  /** Short, deterministic context line (e.g. "Leaderboard #abc · pos 1"). */
  context: string;
  /** Optional drill-in href — links the row to the source surface in the
   *  hub when one exists (creator profile, deal-tracker, leaderboard). */
  href: string | null;
  /** Source system, for the small label on the right. */
  source: "ledger" | "expense";
};

export type SpendEventsPage = {
  rows: SpendEventRow[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  /** Lifetime totals across ALL events matching the current bucket — these
   *  feed the KPI strip above the table. `null` when the count probe
   *  degraded so the UI can show "—" instead of a wrong "0". */
  lifetimeTotalUsd: number | null;
  /** Whether the count aggregate hit a soft failure (separately surfaced). */
  countDegraded: boolean;
};

export const AUDIT_SPEND_PER_PAGE = 25;

const ALL_BUCKET_LABELS: Record<Exclude<SpendBucketKey, "all">, string> = {
  leaderboard: "Leaderboard",
  fill: "Fill program",
  multiplier: "Multiplier deal",
  expense: "Expense",
};

const TX_TYPE_TO_BUCKET: Record<string, Exclude<SpendBucketKey, "all" | "expense">> = (() => {
  const out: Record<string, Exclude<SpendBucketKey, "all" | "expense">> = {};
  for (const t of SPEND_EVENT_BUCKETS.leaderboard) out[t] = "leaderboard";
  for (const t of SPEND_EVENT_BUCKETS.fill) out[t] = "fill";
  for (const t of SPEND_EVENT_BUCKETS.multiplier) out[t] = "multiplier";
  return out;
})();

export function spendBucketLabel(bucket: Exclude<SpendBucketKey, "all">): string {
  return ALL_BUCKET_LABELS[bucket];
}

/** Short human label for a raw tx_type (e.g. "Leaderboard prize", "Fill
 *  conversion"). Kept as a separate map so the badge can show the bucket
 *  while the context line states what kind of leg fired. */
export function spendTypeLabel(rawType: string): string {
  switch (rawType) {
    case "affiliate_leaderboard_creation":
      return "Leaderboard seed";
    case "affiliate_leaderboard_prize":
      return "Leaderboard prize";
    case "creator_fill_activation":
      return "Fill activation";
    case "creator_fill_spend_tip":
      return "Fill tip";
    case "creator_fill_spend_battle":
      return "Fill sponsor";
    case "creator_fill_conversion":
      return "Fill conversion";
    case "creator_deal_fill_grant":
      return "Weekly fill grant";
    case "creator_multiplier_platform_credit":
      return "Multiplier platform credit";
    case "creator_multiplier_settlement_payout":
      return "Multiplier settlement payout";
    case "creator_multiplier_spend_tip":
      return "Multiplier tip";
    case "creator_multiplier_spend_battle":
      return "Multiplier sponsor";
    case "creator_multiplier_spend_wager":
      return "Multiplier wager";
    case "expense":
      return "Expense";
    default:
      return rawType;
  }
}

type LedgerRowRaw = {
  id: string;
  type: string;
  amount: string | number;
  user_id: string | null;
  created_at: Date;
  metadata: Record<string, unknown> | null;
};

type ExpenseRow = {
  id: string;
  date: Date;
  amount: { toString(): string };
  description: string;
  paid_to: string;
  category: string;
};

/**
 * `creator_fill_spend_*` and `creator_multiplier_spend_*` record BOTH a
 * `sent` and a `received` leg for a single event. To avoid
 * double-counting we keep only the `sent` leg (the side that debits the
 * funding wallet). All other types we include are 1-leg events.
 */

/** SQL fragment that limits dual-leg types to the `sent` direction. The
 *  `metadata->>'direction'` cast is null-safe; non-dual-leg rows pass
 *  through. */
const DIRECTION_FILTER_SQL = `
  (
    type::text NOT IN (
      'creator_fill_spend_tip',
      'creator_fill_spend_battle',
      'creator_multiplier_spend_tip',
      'creator_multiplier_spend_battle'
    )
    OR COALESCE(metadata->>'direction', 'sent') = 'sent'
  )
`;

function inListSql(types: readonly string[]): string {
  // All values come from the typed const above — no untrusted input.
  return types.map((t) => `'${t}'`).join(",");
}

function bucketTypes(bucket: SpendBucketKey): readonly string[] {
  if (bucket === "all" || bucket === "expense") {
    return HOUSE_CREATOR_COST_TX_TYPES;
  }
  return SPEND_EVENT_BUCKETS[bucket];
}

async function queryLedgerSlice(
  bucket: SpendBucketKey,
  offset: number,
  limit: number,
): Promise<LedgerRowRaw[]> {
  if (bucket === "expense") return [];
  const db = await getDb();
  const types = bucketTypes(bucket);
  const rows = await db.$queryRawUnsafe<LedgerRowRaw[]>(
    `SELECT id,
            type::text AS type,
            amount,
            user_id,
            created_at,
            metadata
       FROM ledger_transactions
      WHERE status = 'completed'
        AND type::text IN (${inListSql(types)})
        AND ${DIRECTION_FILTER_SQL}
      ORDER BY created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}`,
  );
  return rows;
}

async function queryLedgerCount(bucket: SpendBucketKey): Promise<number> {
  if (bucket === "expense") return 0;
  const db = await getDb();
  const types = bucketTypes(bucket);
  const rows = await db.$queryRawUnsafe<{ n: string | number | bigint }[]>(
    `SELECT COUNT(*)::text AS n
       FROM ledger_transactions
      WHERE status = 'completed'
        AND type::text IN (${inListSql(types)})
        AND ${DIRECTION_FILTER_SQL}`,
  );
  return toNumber(rows[0]?.n ?? 0);
}

async function queryLedgerLifetimeTotal(bucket: SpendBucketKey): Promise<number> {
  if (bucket === "expense") return 0;
  const db = await getDb();
  const types = bucketTypes(bucket);
  const rows = await db.$queryRawUnsafe<{ s: string | null }[]>(
    `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS s
       FROM ledger_transactions
      WHERE status = 'completed'
        AND type::text IN (${inListSql(types)})
        AND ${DIRECTION_FILTER_SQL}`,
  );
  return toNumber(rows[0]?.s ?? 0);
}

async function queryExpensesSlice(
  offset: number,
  limit: number,
): Promise<ExpenseRow[]> {
  return adminDb.expenses.findMany({
    where: {
      category: { in: CREATOR_EXPENSE_CATEGORIES },
    },
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      paid_to: true,
      category: true,
    },
    orderBy: { date: "desc" },
    take: limit,
    skip: offset,
  });
}

async function queryExpensesCount(): Promise<number> {
  return adminDb.expenses.count({
    where: { category: { in: CREATOR_EXPENSE_CATEGORIES } },
  });
}

async function queryExpensesLifetimeTotal(): Promise<number> {
  const result = await adminDb.expenses.aggregate({
    where: { category: { in: CREATOR_EXPENSE_CATEGORIES } },
    _sum: { amount: true },
  });
  return toNumber(result._sum.amount ?? 0);
}

/** Expense categories that represent creator-/marketing-related spend.
 *  Free-text in admin-db, so we match on lower-cased substring. */
const CREATOR_EXPENSE_CATEGORIES_LOWER = [
  "creator",
  "creators",
  "marketing",
  "influencer",
  "sponsorship",
  "campaign",
  "advertising",
  "ads",
];

// Built up at query time — for `findMany` we use an IN list of the
// canonical capitalizations the team actually writes. Anything that
// matches lower-cased substring gets a place in this list once seen.
// In practice the team writes "Creator", "Marketing", "Influencer" — we
// match both casings to cover legacy and new rows.
const CREATOR_EXPENSE_CATEGORIES: string[] = (() => {
  const out = new Set<string>();
  for (const k of CREATOR_EXPENSE_CATEGORIES_LOWER) {
    out.add(k);
    out.add(k.charAt(0).toUpperCase() + k.slice(1));
    out.add(k.toUpperCase());
  }
  return Array.from(out);
})();

type UserLite = { id: string; username: string | null; image: string | null };

async function fetchUserLookup(
  ids: string[],
): Promise<Map<string, UserLite>> {
  const lookup = new Map<string, UserLite>();
  if (ids.length === 0) return lookup;
  const db = await getDb();
  const unique = Array.from(new Set(ids));
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, username: true, image: true },
  });
  for (const u of users) lookup.set(u.id, u);
  return lookup;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!metadata) return null;
  const v = metadata[key];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function metadataNumber(
  metadata: Record<string, unknown> | null,
  key: string,
): number | null {
  if (!metadata) return null;
  const v = metadata[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function ledgerRowToEvent(
  raw: LedgerRowRaw,
  users: Map<string, UserLite>,
): SpendEventRow {
  const rawType = raw.type;
  const bucket = TX_TYPE_TO_BUCKET[rawType] ?? "fill";
  const md = raw.metadata;

  // For fill spends, the "recipient" of the tip/sponsor is the END user
  // who received it; the row's user_id is the creator who DISBURSED it
  // from the house pot. We show the creator who fired the leg, since
  // this view is per creator-cost event from the house perspective.
  const userId = raw.user_id;
  const user = userId ? users.get(userId) ?? null : null;
  const userLite = user
    ? { id: user.id, username: user.username, image: user.image }
    : null;

  // Build a deterministic context line + drill-in href.
  let context: string;
  let href: string | null = null;
  switch (rawType) {
    case "affiliate_leaderboard_prize": {
      const pos = metadataNumber(md, "position");
      const lbId = metadataString(md, "leaderboard_id");
      const wager = metadataNumber(md, "total_wagered_usd");
      context =
        `Leaderboard payout` +
        (pos != null ? ` · pos ${pos}` : "") +
        (wager != null ? ` · $${wager.toLocaleString()} wagered` : "");
      href = lbId ? `/creator-hub/leaderboards/${lbId}` : null;
      break;
    }
    case "affiliate_leaderboard_creation": {
      const lbId = metadataString(md, "leaderboard_id");
      context = "Leaderboard pool seed";
      href = lbId ? `/creator-hub/leaderboards/${lbId}` : null;
      break;
    }
    case "creator_fill_activation": {
      const dealId = metadataString(md, "deal_id");
      context = "Session fill activation";
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    case "creator_fill_spend_tip": {
      const recipient = metadataString(md, "recipient_user_id");
      context = `Tip from fill pot${recipient ? ` to ${shortId(recipient)}` : ""}`;
      const dealId = metadataString(md, "deal_id");
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    case "creator_fill_spend_battle": {
      context = "Battle sponsor from fill pot";
      const dealId = metadataString(md, "deal_id");
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    case "creator_fill_conversion": {
      const rate = metadataNumber(md, "conversion_rate_bps");
      const forfeited = metadataNumber(md, "forfeited_usd");
      context =
        `Fill conversion` +
        (rate != null ? ` · ${(rate / 100).toFixed(0)}% kept` : "") +
        (forfeited != null ? ` · $${forfeited.toLocaleString()} forfeited` : "");
      const dealId = metadataString(md, "deal_id");
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    case "creator_deal_fill_grant": {
      const perFill = metadataNumber(md, "per_fill_amount_usd");
      const fills = metadataNumber(md, "fills_allowed");
      context =
        `Weekly fill grant` +
        (fills != null && perFill != null
          ? ` · ${fills} × $${perFill}`
          : "");
      const dealId = metadataString(md, "deal_id");
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    case "creator_multiplier_platform_credit":
    case "creator_multiplier_spend_tip":
    case "creator_multiplier_spend_battle":
    case "creator_multiplier_spend_wager": {
      const dealId = metadataString(md, "deal_id");
      context = spendTypeLabel(rawType);
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    case "creator_multiplier_settlement_payout": {
      const bps = metadataNumber(md, "withdrawable_bps");
      const forfeited = metadataNumber(md, "forfeited_usd");
      context =
        `Multiplier settlement` +
        (bps != null ? ` · ${(bps / 100).toFixed(0)}% kept` : "") +
        (forfeited != null ? ` · $${forfeited.toLocaleString()} forfeited` : "");
      const dealId = metadataString(md, "deal_id");
      href = dealId ? `/creator-hub/deal-tracker?deal=${dealId}` : null;
      break;
    }
    default: {
      context = spendTypeLabel(rawType);
      break;
    }
  }

  // If we couldn't link the deal, fall back to the recipient creator's
  // hub page so the row always has a click target.
  if (!href && userLite) {
    href = `/creator-hub/creators/${userLite.id}`;
  }

  return {
    key: `ledger:${raw.id}`,
    occurredAt: raw.created_at.toISOString(),
    bucket,
    rawType,
    amountUsd: toNumber(raw.amount),
    user: userLite,
    context,
    href,
    source: "ledger",
  };
}

function expenseRowToEvent(raw: ExpenseRow): SpendEventRow {
  return {
    key: `expense:${raw.id}`,
    occurredAt: raw.date.toISOString(),
    bucket: "expense",
    rawType: "expense",
    amountUsd: toNumber(raw.amount.toString()),
    user: null,
    context: raw.description
      ? `${raw.category} · ${raw.description}`
      : raw.category,
    href: null,
    source: "expense",
  };
}

function shortId(s: string): string {
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function computeSpendEventsPage(
  bucket: SpendBucketKey,
  page: number,
): Promise<SpendEventsPage> {
  return withTiming("creator-hub.audit-spend", async () => {
    const perPage = AUDIT_SPEND_PER_PAGE;
    const offset = Math.max(0, (page - 1) * perPage);

    // Expense bucket = admin DB only.
    if (bucket === "expense") {
      const [rows, total, lifetimeTotal] = await Promise.all([
        queryExpensesSlice(offset, perPage),
        queryExpensesCount(),
        queryExpensesLifetimeTotal(),
      ]);
      const eventRows = rows.map(expenseRowToEvent);
      return {
        rows: eventRows,
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
        lifetimeTotalUsd: lifetimeTotal,
        countDegraded: false,
      };
    }

    // Ledger-only buckets (all / leaderboard / fill / multiplier). We do
    // NOT merge expenses into the ledger pages — they have different
    // ordering granularity (date vs timestamp) and different shapes; the
    // dedicated `expense` chip surfaces them on their own.
    const [sliceRaw, totalRaw, lifetimeTotalRaw] = await Promise.all([
      queryLedgerSlice(bucket, offset, perPage),
      queryLedgerCount(bucket),
      queryLedgerLifetimeTotal(bucket),
    ]);

    const userIds = sliceRaw
      .map((r) => r.user_id)
      .filter((x): x is string => typeof x === "string");
    const userLookup = await fetchUserLookup(userIds);
    const rows = sliceRaw.map((r) => ledgerRowToEvent(r, userLookup));

    return {
      rows,
      page,
      perPage,
      total: totalRaw,
      totalPages: Math.max(1, Math.ceil(totalRaw / perPage)),
      lifetimeTotalUsd: lifetimeTotalRaw,
      countDegraded: false,
    };
  });
}

const cachedSpendEventsPage = unstable_cache(
  computeSpendEventsPage,
  ["creator-hub-audit-spend-v1"],
  { revalidate: 120, tags: ["creator-hub", "creator-hub-audit-spend"] },
);

export async function getSpendEventsPage(
  bucket: SpendBucketKey,
  page: number,
): Promise<SpendEventsPage> {
  return cachedSpendEventsPage(bucket, page);
}
