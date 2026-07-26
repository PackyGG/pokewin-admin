import "server-only";

import { unstable_cache } from "next/cache";

import { drizzleForEnv } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { escapeBlacklistIds } from "@/lib/queries/_blacklist";

/**
 * Lifetime lookback cap (days) for the tips/sponsor scan. This is a
 * lifetime, roster-wide aggregate with no period selector, so without a
 * bound the scan reaches the entire `ledger_transactions` history once the
 * `creator_fill_spend_*` enum members populate (they are absent from the
 * prod enum today → the query matches zero rows). Bounding the scan to the
 * last year keeps it tractable, matching the 365-day guard used on the
 * heavy insights-rewards pairing scans (`LIFETIME_PAIRING_LOOKBACK_DAYS`).
 *
 * NOTE (money-exactness): once the fill system is live this changes the
 * displayed figure from "all-time" to "last 365d" of tips/sponsor spend.
 * That is the accepted trade-off for an otherwise-unbounded lifetime scan
 * (Active-Timeframe-Only rule); flag for owner sign-off if a true all-time
 * total is ever required on this tile.
 */
const TIPS_SPONSOR_LOOKBACK_DAYS = 365;

/**
 * LIFETIME house spend on creator-given TIPS + battle SPONSORSHIPS — the
 * separate, HOUSE-funded tips/sponsor pool from §3 of the creator model.
 *
 * Creators use this pool (system-generated, NOT player funds) to tip/gift
 * users or sponsor users with balance for battles. When a creator spends
 * from it, the house records the cost in the ledger as:
 *
 *   • `creator_fill_spend_tip`    → a creator-funded tip handed to a user
 *   • `creator_fill_spend_battle` → a creator-funded battle sponsorship
 *
 * Both are a HOUSE COST (the pool is house-provided), so the /creators box
 * colours them rose (house-POV). Lifetime scope, no per-period fan-out —
 * this is a single roster-wide "how much have we ever spent on this" figure.
 *
 * ─── ENUM-SAFETY (CRITICAL) ──────────────────────────────────────────
 *
 * A recent audit found the live prod `ledger_transaction_type` enum holds
 * only a subset of its 42 schema members — the `creator_fill_*` values may
 * NOT exist in the prod enum yet (the fill system isn't populated). A
 * direct `type IN ('creator_fill_spend_tip', …)` compares against an enum
 * literal and Postgres throws `invalid input value for enum
 * ledger_transaction_type` at PARSE time if a literal isn't a member —
 * taking the whole query (and tile) down.
 *
 * So we filter via `type::text IN ('creator_fill_spend_tip', …)`: casting
 * the column to text makes it a plain string comparison that simply matches
 * zero rows when the value isn't present, NEVER an enum-membership error.
 * The box safely reads $0 until the fill system is live. Callers
 * additionally wrap this in `safeQueryOrNull` so any other failure degrades
 * to null (→ "$0") rather than crashing /creators.
 *
 * Single round-trip, grouped by type so both legs come back in one pass.
 *
 * ─── BLACKLIST SCOPE ─────────────────────────────────────────────────
 *
 * The admin-managed `excluded_users` blacklist is applied to the RECEIVING
 * `lt.user_id` on both legs so a blacklisted recipient never appears
 * ANYWHERE — matching the `/dashboard` "Creators Costs (today)" twin
 * (`getCreatorCostsToday`, which blacklists the same `creator_fill_spend_tip`
 * leg) so the lifetime roster tile and the today tile reconcile on ONE
 * population. Staff/creator roles are NOT dropped: the spend leg's subject is
 * the creator who funded it, and it is a real house outflow regardless of the
 * recipient's role — only the blacklist is applied (matching the per-creator
 * fill cost). Inlined via the canonical pre-escaped id list (whole-roster
 * aggregate; the two type literals are fixed, no bind params).
 */
export type TipsSponsorSpend = {
  /** Σ |amount| over `creator_fill_spend_tip`, status=completed (rose). */
  tipSpendUsd: number;
  /** Σ |amount| over `creator_fill_spend_battle`, status=completed (rose). */
  sponsorSpendUsd: number;
  /** tipSpendUsd + sponsorSpendUsd — the combined house cost (rose). */
  totalUsd: number;
};

/**
 * The lifetime tips/sponsor scan, wrapped in `unstable_cache` (300s — a
 * lifetime, roster-wide house-cost figure; a ≤5-min staleness is fine and
 * collapses concurrent /creators renders onto one warmed entry instead of
 * re-scanning `ledger_transactions` on every load).
 *
 * Env + blacklist are request-scoped (the Main-DB env toggle reads the
 * request cookie, the blacklist is an admin-DB read) and CANNOT be resolved
 * inside an `unstable_cache` callback, so they are resolved OUTSIDE by the
 * public wrapper and threaded in via this factory closure — the same
 * handling `code-and-wager-by-user.ts` / `all-creators-net-pnl.ts` use.
 * They are folded into the key parts so prod/dev and each distinct
 * blacklist land in a separate slot.
 */
const cachedTipsSponsorSpend = (env: DbEnv, excludedIds: string[]) =>
  unstable_cache(
    async (): Promise<TipsSponsorSpend> => {
      const db = drizzleForEnv(env);

      // Blacklist gate: drop excluded (owner-locked) recipient ids so a
      // blacklisted user who received a creator-funded tip/sponsorship never
      // contributes — mirrors the `/dashboard` "Creators Costs (today)" twin.
      // Guarded for the empty set so the SQL stays valid when nothing is
      // excluded; inlined via the canonical pre-escaped id list.
      const blacklistClause =
        excludedIds.length > 0
          ? `AND lt.user_id NOT IN (${escapeBlacklistIds(excludedIds)})`
          : "";

      // `type::text IN (...)` — text comparison, never an enum-membership
      // error if a `creator_fill_*` member is absent from the prod enum (see
      // header). Bounded to the last TIPS_SPONSOR_LOOKBACK_DAYS so a lifetime
      // scan can't hit the whole `ledger_transactions` history once the fill
      // enum populates.
      const rows = await queryRows<
        { type: string; total: string | null }[]
      >(db,
        `SELECT lt.type::text AS type,
               COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type::text IN ('creator_fill_spend_tip', 'creator_fill_spend_battle')
          AND lt.created_at >= NOW() - INTERVAL '${TIPS_SPONSOR_LOOKBACK_DAYS} days'
          ${blacklistClause}
        GROUP BY lt.type::text`,
      );

      let tipSpendUsd = 0;
      let sponsorSpendUsd = 0;
      for (const r of rows) {
        const amt = Number(r.total ?? 0) || 0;
        if (r.type === "creator_fill_spend_tip") tipSpendUsd = amt;
        else if (r.type === "creator_fill_spend_battle") sponsorSpendUsd = amt;
      }

      return {
        tipSpendUsd,
        sponsorSpendUsd,
        totalUsd: tipSpendUsd + sponsorSpendUsd,
      };
    },
    ["creators-tips-sponsor-spend-v1", env, ...excludedIds],
    { revalidate: 300, tags: ["creators-tips-sponsor-spend"] },
  );

export async function getTipsSponsorSpend(): Promise<TipsSponsorSpend> {
  // Resolve env + blacklist in REQUEST scope (cookie + admin-DB reads that
  // can't run inside the unstable_cache callback) and thread them in so
  // prod/dev and each blacklist land in a separate cache slot. The blacklist
  // is sorted so the cache key is stable regardless of id order.
  const env = await readDbEnv();
  const excludedIds = [...(await getExcludedUserIds())].sort();
  return cachedTipsSponsorSpend(env, excludedIds)();
}
