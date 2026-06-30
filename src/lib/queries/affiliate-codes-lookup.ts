import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";

/**
 * Affiliate-codes lookup — read-only, index-served reads for the
 * /insights/affiliate-codes search page.
 *
 * Index strategy (Index-or-ClickHouse rule; every read here is
 * EXPLAIN-proven against prod to hit an index — none seq-scans MAIN):
 *
 *   - exact `code = $1`            → `affiliate_codes_code_unique` (Index Scan)
 *   - owner `username = $1`        → `user_username_unique`        (Index Scan)
 *   - owner `email = $1`           → `user_email_unique`           (Index Scan)
 *   - owner `lower(username) LIKE` → `idx_user_lower_username_prefix`
 *                                    (text_pattern_ops range, Index Scan)
 *   - codes by owner ids (IN)      → `idx_affiliate_codes_user_created_at`
 *   - account by user_id / IN      → `affiliate_accounts_pkey`
 *   - usages by affiliate_user_id  → `idx_affiliate_code_usages_affiliate_referred`
 *
 *   - code PREFIX (`code LIKE 'X%'`) does NOT hit the default-collation
 *     unique index — it needs the `text_pattern_ops` index flagged in
 *     `prisma/recommended-indexes.sql` (#21). Until the owner applies it,
 *     code-prefix search is intentionally DISABLED here (see
 *     CODE_PREFIX_INDEX_APPLIED) so we never ship a seq scan on MAIN. Code
 *     search is exact-only; owner username/email is exact + username
 *     prefix (both already indexed).
 *
 * All money is Decimal(20,2) in the DB → carried as a string and parsed
 * with Number() at the boundary (no Float arithmetic).
 */

/**
 * Flip to `true` only AFTER the owner has applied recommended-index #21
 * (`idx_affiliate_codes_code_prefix`). Leaving it `false` keeps the
 * code-prefix path off so the Index-or-ClickHouse rule holds (no seq scan
 * on MAIN). When `true`, an exact-code miss falls back to a prefix search
 * that uses the new text_pattern_ops index.
 */
export const CODE_PREFIX_INDEX_APPLIED = false;

export type AffiliateCodeRow = {
  /** affiliate_codes.id (uuid) */
  id: string;
  code: string;
  createdAt: string; // ISO
  owner: {
    id: string;
    username: string | null;
    email: string | null;
  };
  /** From affiliate_accounts (per-user PK). Null when the owner has no row. */
  account: {
    totalReferred: number;
    totalWagerVolumeUsd: number;
    totalEarnedUsd: number;
    availableUsd: number;
    totalPaidOutUsd: number;
  } | null;
};

export type AffiliateCodeUsageRow = {
  id: string;
  code: string;
  referredUserId: string;
  referredUsername: string | null;
  depositAmountUsd: number;
  referrerCutUsd: number;
  wagerAmountUsd: number;
  status: string;
  createdAt: string; // ISO
};

function dec(value: { toString(): string } | null | undefined): number {
  if (value == null) return 0;
  return Number(value.toString());
}

/** Normalise a raw query into a trimmed string (max 64 chars, defensive). */
export function normalizeQuery(raw: string | undefined | null): string {
  return (raw ?? "").trim().slice(0, 64);
}

/**
 * Escape the LIKE wildcard metacharacters (`%`, `_`, `\`) in user input so a
 * raw prefix search treats them literally (the prefix `%` is appended by the
 * SQL, not the user). Pairs with `ESCAPE '\'` in the query.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Search affiliate codes by `code` and/or owner username/email.
 *
 * Strategy (all index-served):
 *   1. Exact `code = q`  → the unique index. The single strongest signal,
 *      tried first.
 *   2. Owner exact `username = q` OR `email = q` → unique indexes. Then
 *      that owner's codes via the (user_id, created_at) index.
 *   3. Owner `lower(username) LIKE 'q%'` (prefix) → the text_pattern_ops
 *      index, bounded to 25 owners, then their codes.
 *   4. (optional) code prefix — only when CODE_PREFIX_INDEX_APPLIED.
 *
 * Returns up to `limit` distinct codes, enriched with owner + account.
 */
export async function searchAffiliateCodes(
  rawQuery: string,
  limit = 25,
): Promise<AffiliateCodeRow[]> {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];

  const db = await getDb();
  const lower = q.toLowerCase();

  // Collect candidate affiliate_codes rows (deduped by id), all via
  // indexed lookups.
  const byId = new Map<
    string,
    { id: string; user_id: string; code: string; created_at: Date }
  >();

  // 1. Exact code (unique index).
  const exactCode = await db.affiliate_codes.findUnique({
    where: { code: q },
    select: { id: true, user_id: true, code: true, created_at: true },
  });
  if (exactCode) byId.set(exactCode.id, exactCode);

  // 2 + 3. Owner lookups → resolve a bounded set of owner ids, then their
  // codes (indexed by user_id).
  const ownerIds = new Set<string>();

  // exact username / email (two unique-index point lookups).
  const [byUsername, byEmail] = await Promise.all([
    db.user.findUnique({ where: { username: q }, select: { id: true } }),
    q.includes("@")
      ? db.user.findUnique({ where: { email: q }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (byUsername) ownerIds.add(byUsername.id);
  if (byEmail) ownerIds.add(byEmail.id);

  // username prefix — raw query so it hits the `idx_user_lower_username_prefix`
  // (text_pattern_ops on `lower(username)`) index. Prisma's `startsWith`
  // emits `ILIKE`/`LIKE`, which the planner CANNOT serve from that
  // functional index (proven by EXPLAIN → seq scan), so we hand-write the
  // exact `lower(username) LIKE lower($1) || '%'` shape the index matches.
  // The user input is escaped for LIKE metacharacters and bound as a
  // parameter (no SQL injection).
  if (lower.length >= 2) {
    const escaped = escapeLike(q);
    const prefixOwners = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "user"
                 WHERE lower(username) LIKE lower(${escaped}) || '%' ESCAPE '\'
                 ORDER BY username ASC
                 LIMIT 25`,
    );
    for (const u of prefixOwners) ownerIds.add(u.id);
  }

  if (ownerIds.size > 0) {
    const ownerCodes = await db.affiliate_codes.findMany({
      where: { user_id: { in: [...ownerIds] } },
      select: { id: true, user_id: true, code: true, created_at: true },
      orderBy: { created_at: "desc" },
      take: limit,
    });
    for (const c of ownerCodes) byId.set(c.id, c);
  }

  // 4. Optional code-prefix fallback (gated on the flagged index).
  if (CODE_PREFIX_INDEX_APPLIED && byId.size < limit) {
    const prefixCodes = await db.affiliate_codes.findMany({
      where: { code: { startsWith: q } },
      select: { id: true, user_id: true, code: true, created_at: true },
      orderBy: { code: "asc" },
      take: limit,
    });
    for (const c of prefixCodes) byId.set(c.id, c);
  }

  const codes = [...byId.values()]
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
    .slice(0, limit);
  if (codes.length === 0) return [];

  // Enrich: owners (PK IN) + accounts (PK IN) — both indexed batches.
  const userIds = [...new Set(codes.map((c) => c.user_id))];
  const [owners, accounts] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, email: true },
    }),
    db.affiliate_accounts.findMany({
      where: { user_id: { in: userIds } },
      select: {
        user_id: true,
        total_referred: true,
        total_wager_volume_usd: true,
        total_earned_usd: true,
        available_usd: true,
        total_paid_out_usd: true,
      },
    }),
  ]);

  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const accountById = new Map(accounts.map((a) => [a.user_id, a]));

  return codes.map((c) => {
    const owner = ownerById.get(c.user_id);
    const acc = accountById.get(c.user_id);
    return {
      id: c.id,
      code: c.code,
      createdAt: c.created_at.toISOString(),
      owner: {
        id: c.user_id,
        username: owner?.username ?? null,
        email: owner?.email ?? null,
      },
      account: acc
        ? {
            totalReferred: acc.total_referred,
            totalWagerVolumeUsd: dec(acc.total_wager_volume_usd),
            totalEarnedUsd: dec(acc.total_earned_usd),
            availableUsd: dec(acc.available_usd),
            totalPaidOutUsd: dec(acc.total_paid_out_usd),
          }
        : null,
    };
  });
}

/**
 * Recent affiliate_code_usages for one affiliate owner — bounded + indexed
 * via `idx_affiliate_code_usages_affiliate_referred` (leading column
 * affiliate_user_id). NEVER an unbounded scan.
 */
export async function getRecentAffiliateUsages(
  affiliateUserId: string,
  limit = 15,
): Promise<AffiliateCodeUsageRow[]> {
  const db = await getDb();
  const rows = await db.affiliate_code_usages.findMany({
    where: { affiliate_user_id: affiliateUserId },
    select: {
      id: true,
      code: true,
      referred_user_id: true,
      deposit_amount_usd: true,
      referrer_cut_usd: true,
      wager_amount_usd: true,
      status: true,
      created_at: true,
    },
    orderBy: { created_at: "desc" },
    take: limit,
  });
  if (rows.length === 0) return [];

  // Enrich referred usernames via a single PK IN batch.
  const referredIds = [...new Set(rows.map((r) => r.referred_user_id))];
  const referred = await db.user.findMany({
    where: { id: { in: referredIds } },
    select: { id: true, username: true },
  });
  const nameById = new Map(referred.map((u) => [u.id, u.username]));

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    referredUserId: r.referred_user_id,
    referredUsername: nameById.get(r.referred_user_id) ?? null,
    depositAmountUsd: dec(r.deposit_amount_usd),
    referrerCutUsd: dec(r.referrer_cut_usd),
    wagerAmountUsd: dec(r.wager_amount_usd),
    status: r.status,
    createdAt: r.created_at.toISOString(),
  }));
}
