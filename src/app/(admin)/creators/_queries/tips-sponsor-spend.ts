import "server-only";

import { getDb } from "@/lib/db";

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
 * No bind parameters (the two type literals are fixed); single round-trip,
 * grouped by type so both legs come back in one pass. No staff/blacklist
 * scope: these are creator-fill spend legs (the receiving user is just
 * whoever the creator tipped/sponsored), so the gross house spend is the
 * honest figure — matching how the per-creator fill cost is summed.
 */
export type TipsSponsorSpend = {
  /** Σ |amount| over `creator_fill_spend_tip`, status=completed (rose). */
  tipSpendUsd: number;
  /** Σ |amount| over `creator_fill_spend_battle`, status=completed (rose). */
  sponsorSpendUsd: number;
  /** tipSpendUsd + sponsorSpendUsd — the combined house cost (rose). */
  totalUsd: number;
};

export async function getTipsSponsorSpend(): Promise<TipsSponsorSpend> {
  const db = await getDb();

  // `type::text IN (...)` — text comparison, never an enum-membership error
  // if a `creator_fill_*` member is absent from the prod enum (see header).
  const rows = await db.$queryRaw<{ type: string; total: string | null }[]>`
    SELECT lt.type::text AS type,
           COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text IN ('creator_fill_spend_tip', 'creator_fill_spend_battle')
    GROUP BY lt.type::text
  `;

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
}
