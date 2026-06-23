import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";

/**
 * Creator Hub — Audit Spend → Fill Conversions.
 *
 * Per-creator FILL-PROGRAM conversion events grouped by UTC day. One row
 * = one (day, fill session) tuple, amount = Σ of every conversion voucher
 * minted that day for that session.
 *
 * Source: MAIN-DB `vouchers` table, `origin = 'creator_fill_conversion'`.
 * Each voucher is the end-of-session payout the creator earned from a
 * single fill (§2 of the creator model: the "stream payout voucher").
 * Its metadata carries the originating `deal_id` and `session_id` — we
 * group by `(day_utc, deal_id, session_id, user_id)` so each row maps
 * back to ONE underlying fill, and the date breaks out the day it
 * realized.
 *
 * House-POV color (rendered upstream): the owner explicitly framed
 * conversion as the RETURN-SIDE of a fill cost — money the fill brought
 * BACK to us via user wagers (the higher the conversion rate, the more
 * the creator actually played through). The audit-spend table paints
 * these rows EMERALD as a house gain, NOT rose. Activation/spend rows
 * (which ARE pure house cost) stay in the legacy Fill ledger types —
 * those are intentionally hidden from the audit page now per owner
 * directive (see `spend-events.ts`).
 *
 * Index strategy (probed read-only against prod 2026-06-23):
 *   - `idx_vouchers_origin_created_at` on (origin, created_at DESC).
 *   - Bare enum comparison `origin = 'creator_fill_conversion'::voucher_origin`
 *     drives a Bitmap Heap Scan (~10 ms aggregate, 25 rows / 100 offset).
 *     The legacy `::text` cast in some other modules disables the index
 *     and falls back to Seq Scan — DO NOT copy that pattern here.
 *   - Count of distinct groups is ~10 ms (same Bitmap scan).
 *
 * Reads only. MAIN is read-only.
 */

/** One row in the fill-conversion list. One (day, fill) pair. */
export type FillConversionRow = {
  /** Stable per-row key: `fillconv:<YYYY-MM-DD>:<session_id|noSession>:<user_id>`. */
  key: string;
  /** Start-of-day instant in UTC for the day this conversion belongs to. */
  dayIso: string;
  /** Fill deal id (from voucher metadata). */
  dealId: string | null;
  /** Fill session id (from voucher metadata) — primary fill reference. */
  sessionId: string | null;
  /** Creator the fill belongs to. */
  user: {
    id: string;
    username: string | null;
    image: string | null;
  } | null;
  /** Σ of conversion voucher values minted that day for that fill. */
  amountUsd: number;
  /** How many conversion vouchers rolled into this row (usually 1). */
  voucherCount: number;
  /** Activation cost of the originating fill, if we could resolve it
   *  (matched on (deal_id, session_id) → earliest `creator_fill_activation`
   *  ledger row). Used for the "from $X fill" subtitle. */
  activation: {
    amountUsd: number;
    activatedAtIso: string;
  } | null;
};

export type FillConversionsPage = {
  rows: FillConversionRow[];
  page: number;
  perPage: number;
  /** Number of (day, fill) groups in lifetime. */
  total: number;
  totalPages: number;
  /** Σ of every conversion voucher value, lifetime — feeds the KPI strip. */
  lifetimeTotalUsd: number | null;
  /** Number of underlying conversion vouchers — context for the KPI. */
  lifetimeVoucherCount: number | null;
};

export const FILL_CONVERSIONS_PER_PAGE = 25;

/** Raw `(day, fill)` group row as it comes off the DB. Exported for the
 *  `spend-events.ts` `all`-merge path which reuses the same SQL. */
export type FillSliceRow = {
  day_utc: Date;
  deal_id: string | null;
  session_id: string | null;
  user_id: string | null;
  amount: string | null;
  voucher_count: string | number | bigint;
  last_at: Date;
};

/** Slice the per-(day, fill) group feed. Index-served — see file header. */
export async function queryFillConversionSlice(
  offset: number,
  limit: number,
): Promise<FillSliceRow[]> {
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<FillSliceRow[]>(
    `SELECT
       date_trunc('day', v.created_at AT TIME ZONE 'UTC') AS day_utc,
       v.metadata->>'deal_id'    AS deal_id,
       v.metadata->>'session_id' AS session_id,
       v.user_id                  AS user_id,
       SUM(v.value::numeric)::text AS amount,
       COUNT(*)::text              AS voucher_count,
       MAX(v.created_at)           AS last_at
       FROM vouchers v
       WHERE v.origin = 'creator_fill_conversion'::voucher_origin
       GROUP BY 1, 2, 3, 4
       ORDER BY day_utc DESC, last_at DESC
       LIMIT ${limit}
       OFFSET ${offset}`,
  );
  return rows;
}

export async function queryFillConversionGroupCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<{ n: string | number | bigint }[]>(
    `SELECT COUNT(*)::text AS n
       FROM (
         SELECT 1
         FROM vouchers v
         WHERE v.origin = 'creator_fill_conversion'::voucher_origin
         GROUP BY date_trunc('day', v.created_at AT TIME ZONE 'UTC'),
                  v.metadata->>'deal_id',
                  v.metadata->>'session_id',
                  v.user_id
       ) g`,
  );
  return toNumber(rows[0]?.n ?? 0);
}

export async function queryFillConversionLifetimeTotal(): Promise<{
  amount: number;
  count: number;
}> {
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<
    { s: string | null; n: string | number | bigint }[]
  >(
    `SELECT COALESCE(SUM(v.value::numeric), 0)::text AS s,
            COUNT(*)::text AS n
       FROM vouchers v
       WHERE v.origin = 'creator_fill_conversion'::voucher_origin`,
  );
  return {
    amount: toNumber(rows[0]?.s ?? 0),
    count: toNumber(rows[0]?.n ?? 0),
  };
}

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

/**
 * Resolve the originating fill activation for the (deal_id, session_id)
 * tuples on the current slice. Activation rows are 1:N with conversions
 * (a session has one or more activations and may have multiple
 * conversions on different days). We fetch only the activations
 * referenced by the current slice — bounded by the slice size, so this
 * is at most a few dozen lookups per page.
 *
 * If a session has multiple activation rows (fills_used > 1) we pick
 * the EARLIEST as the "original" fill amount the session started with.
 * If no activation row exists (legacy / orphan data) the row's
 * `activation` field stays null — the table renders without the
 * "from $X fill" subtitle.
 */
export async function fetchActivationLookup(
  pairs: { dealId: string; sessionId: string }[],
): Promise<Map<string, { amountUsd: number; activatedAtIso: string }>> {
  const out = new Map<
    string,
    { amountUsd: number; activatedAtIso: string }
  >();
  if (pairs.length === 0) return out;
  const db = await getDb();
  // All ids come from voucher metadata strings — never user input — but
  // they're still passed via $N bind params for safety.
  const params: string[] = [];
  const tuples: string[] = [];
  for (const p of pairs) {
    params.push(p.dealId, p.sessionId);
    const i = params.length;
    tuples.push(`($${i - 1}, $${i})`);
  }
  const sql = `
    SELECT
      lt.metadata->>'deal_id'    AS deal_id,
      lt.metadata->>'session_id' AS session_id,
      lt.amount::text             AS amount,
      lt.created_at               AS created_at
      FROM ledger_transactions lt
      JOIN (VALUES ${tuples.join(",")}) AS j(d, s)
        ON j.d = lt.metadata->>'deal_id'
       AND j.s = lt.metadata->>'session_id'
     WHERE lt.type = 'creator_fill_activation'::ledger_transaction_type
       AND lt.status = 'completed'
  `;
  type Row = {
    deal_id: string | null;
    session_id: string | null;
    amount: string;
    created_at: Date;
  };
  const rows = await db.$queryRawUnsafe<Row[]>(sql, ...params);
  for (const r of rows) {
    if (!r.deal_id || !r.session_id) continue;
    const key = `${r.deal_id}:${r.session_id}`;
    const ts = new Date(r.created_at).getTime();
    const existing = out.get(key);
    if (!existing || ts < new Date(existing.activatedAtIso).getTime()) {
      out.set(key, {
        amountUsd: toNumber(r.amount),
        activatedAtIso: new Date(r.created_at).toISOString(),
      });
    }
  }
  return out;
}

/** Convert a slice + lookups into `FillConversionRow[]`. Shared with the
 *  `all`-merge path in `spend-events.ts`. */
export function hydrateFillConversionRows(
  sliceRaw: FillSliceRow[],
  userLookup: Map<string, UserLite>,
  activationLookup: Map<
    string,
    { amountUsd: number; activatedAtIso: string }
  >,
): FillConversionRow[] {
  return sliceRaw.map((r) => {
    const dayIso = new Date(r.day_utc).toISOString();
    const user = r.user_id ? userLookup.get(r.user_id) ?? null : null;
    const activation =
      r.deal_id && r.session_id
        ? activationLookup.get(`${r.deal_id}:${r.session_id}`) ?? null
        : null;
    const dayKey = dayIso.slice(0, 10);
    return {
      key: `fillconv:${dayKey}:${r.session_id ?? "noSession"}:${r.user_id ?? "noUser"}`,
      dayIso,
      dealId: r.deal_id,
      sessionId: r.session_id,
      user: user
        ? { id: user.id, username: user.username, image: user.image }
        : null,
      amountUsd: toNumber(r.amount),
      voucherCount: toNumber(r.voucher_count),
      activation,
    };
  });
}

async function computeFillConversionsPage(
  page: number,
): Promise<FillConversionsPage> {
  return withTiming("creator-hub.audit-spend.fill-conversions", async () => {
    const perPage = FILL_CONVERSIONS_PER_PAGE;
    const offset = Math.max(0, (page - 1) * perPage);

    const [sliceRaw, total, lifetime] = await Promise.all([
      queryFillConversionSlice(offset, perPage),
      queryFillConversionGroupCount(),
      queryFillConversionLifetimeTotal(),
    ]);

    const userIds = sliceRaw
      .map((r) => r.user_id)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    const activationPairs = sliceRaw
      .map((r) =>
        r.deal_id && r.session_id
          ? { dealId: r.deal_id, sessionId: r.session_id }
          : null,
      )
      .filter((x): x is { dealId: string; sessionId: string } => x !== null);

    const [userLookup, activationLookup] = await Promise.all([
      fetchUserLookup(userIds),
      fetchActivationLookup(activationPairs),
    ]);

    const rows = hydrateFillConversionRows(
      sliceRaw,
      userLookup,
      activationLookup,
    );

    return {
      rows,
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      lifetimeTotalUsd: lifetime.amount,
      lifetimeVoucherCount: lifetime.count,
    };
  });
}

const cachedFillConversionsPage = unstable_cache(
  computeFillConversionsPage,
  ["creator-hub-audit-spend-fill-conversions-v1"],
  { revalidate: 120, tags: ["creator-hub", "creator-hub-audit-spend"] },
);

export async function getFillConversionsPage(
  page: number,
): Promise<FillConversionsPage> {
  return cachedFillConversionsPage(page);
}

/** Helper exposed for the `spend-events.ts` `all`-merge path. Re-uses the
 *  same internal user + activation lookups so output stays identical to
 *  the dedicated Fill chip. Cached per (page, perPage) tuple. */
const cachedFillConversionsWindow = unstable_cache(
  async (windowSize: number) => {
    const [sliceRaw, total, lifetime] = await Promise.all([
      queryFillConversionSlice(0, windowSize),
      queryFillConversionGroupCount(),
      queryFillConversionLifetimeTotal(),
    ]);
    const userIds = sliceRaw
      .map((r) => r.user_id)
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    const activationPairs = sliceRaw
      .map((r) =>
        r.deal_id && r.session_id
          ? { dealId: r.deal_id, sessionId: r.session_id }
          : null,
      )
      .filter((x): x is { dealId: string; sessionId: string } => x !== null);
    const [userLookup, activationLookup] = await Promise.all([
      fetchUserLookup(userIds),
      fetchActivationLookup(activationPairs),
    ]);
    const rows = hydrateFillConversionRows(
      sliceRaw,
      userLookup,
      activationLookup,
    );
    return { rows, total, lifetimeTotalUsd: lifetime.amount };
  },
  ["creator-hub-audit-spend-fill-conversions-window-v1"],
  { revalidate: 120, tags: ["creator-hub", "creator-hub-audit-spend"] },
);

export async function getFillConversionsLeadingWindow(
  windowSize: number,
): Promise<{
  rows: FillConversionRow[];
  total: number;
  lifetimeTotalUsd: number;
}> {
  return cachedFillConversionsWindow(Math.max(1, windowSize));
}
