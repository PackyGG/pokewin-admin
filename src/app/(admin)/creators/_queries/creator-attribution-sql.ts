import "server-only";

/**
 * creator-attribution-sql.ts — the SINGLE canonical "is this gaming event
 * attributed to creator C" SQL predicate, generalised from the 7-day
 * deposit-coverage logic in `creators-pnl.ts` (`COVERING_CREATOR_SQL`) to
 * ALL gaming legs (wager, inventory payout, ledger gaming payout, upgrader).
 *
 * ⚠️ STATUS: this helper currently has NO callers — the live per-creator
 * P&L attribution runs through `COVERING_CREATOR_SQL` in
 * `src/lib/queries/creators-pnl.ts`, NOT this function. It is therefore NOT
 * on the /creators/[userId] timeout hot path; rewriting it changes no
 * runtime behaviour. Kept as the intended generalised form for the broader
 * per-creator GGR work. NOTE: like `COVERING_CREATOR_SQL`, its
 * `(referred_user_id, created_at)` access pattern needs the composite index
 * documented there — the doubly-nested EXISTS shape below does NOT remove
 * that index requirement, so it is not a faster substitute for the LIMIT-1
 * form when the index is present.
 *
 * ─── WHY A COVERAGE WINDOW (not the acu wager row itself) ────────────
 *
 * The existing per-creator GGR-ish surfaces lean on `acu.wager_amount_usd`
 * (the backend writes one acu `usage_type='wager'` row per wager while a
 * code is active). That is fine for a wager VOLUME number, but it cannot
 * reconstruct the canonical gaming PAYOUT (inventory `value_at_obtained`,
 * `battle_refund`, `battle_excess_to_voucher`, upgrader `won_amount`),
 * because those payout legs are NOT in `affiliate_code_usages`. To build a
 * real per-creator GGR (wager − payout) we must attribute the SAME
 * canonical legs the metric layer reads, event-by-event, to a creator.
 *
 * So we attribute by COVERAGE WINDOW, exactly like the deposit model:
 *
 *   A gaming event at time T by user U is attributed to creator C iff U
 *   has at least one `affiliate_code_usages` row under C's code with
 *   `created_at ∈ [T − 7 days, T]`, AND there is no MORE-RECENT covering
 *   acu row (under ANY creator) in that same window — i.e. C's code was
 *   the code-of-record for U at time T.
 *
 * `useAffiliateCode` sets `expires_at = NOW + 7d`, so a code applied at
 * time A covers events through A + 7d. The "no more-recent covering acu"
 * arm is the set-based equivalent of the existing
 * `ORDER BY acu.created_at DESC LIMIT 1` tiebreak: on code-hopping
 * (overlapping windows from two creators) the LATEST acu wins, so the
 * event lands on the creator the user most recently switched to. The
 * `referred_user_id != affiliate_user_id` guard drops a creator's OWN
 * self-attributed on-stream wager (a creator using their own code).
 *
 * SAFETY: every identifier below is a hardcoded SQL literal. The only
 * interpolation is the column names the caller passes (`userCol`/`tsCol`)
 * and the creator-id BIND PLACEHOLDER — never the creator-id VALUE. Pass
 * the creator id as a query parameter (`$1`), not concatenated.
 */

/**
 * Build the correlated `EXISTS (…)` attribution predicate for a single
 * creator, to AND into a gaming-leg WHERE clause.
 *
 *   • `userCol` — the event's user-id column (e.g. `lt.user_id`,
 *     `ui.user_id`, `ug.user_id`). Inlined verbatim — pass a trusted,
 *     hardcoded identifier only.
 *   • `tsCol` — the event's timestamp column (e.g. `lt.created_at`,
 *     `ui.obtained_at`, `ug.created_at`). Same trust requirement.
 *   • `creatorBind` — the SQL bind placeholder that carries the creator's
 *     user-id VALUE (default `$1`). NEVER pass a raw id string here.
 *
 * The acu rows are scoped with `::text` casts on `usage_type` for the
 * member-existence comparison so a missing enum member can never trip
 * `22P02` — same hardening the streamers / code-hopper queries use. We do
 * NOT restrict the covering acu to `usage_type='deposit'`: any acu row
 * (deposit / wager / signup) that carries the code at time T establishes
 * coverage, matching the backend's code-of-record semantics (a user can be
 * inside a code's 7-day window from a wager-time acu without a deposit acu,
 * because the backend only writes a deposit acu on the FIRST-EVER deposit).
 */
export function creatorAttributionExists(opts: {
  userCol: string;
  tsCol: string;
  creatorBind?: string;
}): string {
  const { userCol, tsCol } = opts;
  const creator = opts.creatorBind ?? "$1";
  return `EXISTS (
    SELECT 1
      FROM affiliate_code_usages acu_a
     WHERE acu_a.referred_user_id = ${userCol}
       AND acu_a.affiliate_user_id = ${creator}
       AND acu_a.referred_user_id <> acu_a.affiliate_user_id
       AND acu_a.created_at <= ${tsCol}
       AND acu_a.created_at >= ${tsCol} - INTERVAL '7 days'
       AND NOT EXISTS (
         SELECT 1
           FROM affiliate_code_usages acu_b
          WHERE acu_b.referred_user_id = ${userCol}
            AND acu_b.referred_user_id <> acu_b.affiliate_user_id
            AND acu_b.created_at <= ${tsCol}
            AND acu_b.created_at >= ${tsCol} - INTERVAL '7 days'
            AND acu_b.created_at > acu_a.created_at
       )
  )`;
}

/** The 7-day coverage interval, exported so docs / labels stay in sync. */
export const CREATOR_COVERAGE_DAYS = 7 as const;
