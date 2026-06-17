import "server-only";

/**
 * Canonical reusable ClickHouse read helpers for NEW Phase 2B/2C surface query
 * modules. A new `queries/<area>/<surface>.ts` imports these so every surface
 * produces a byte-identical scope (same DB, same DateTime formatting, same
 * wholesale customer-scope CTE) without re-inlining the logic.
 *
 * The already-validated Phase 2A modules (`window-metrics.ts`,
 * `dashboard-cashflow.ts`, …) keep their own inline copies untouched — do NOT
 * retrofit them onto this file (avoids any parity risk).
 *
 * CH boundary: this module imports NO Postgres/Prisma client (directly or
 * transitively) — money stays Decimal end-to-end (toString(sum(...)) in SQL,
 * toNumber() in TS, never Float).
 */

export const CH_DB = "packy_prod";

/** JS Date (UTC) → ClickHouse DateTime64 literal 'YYYY-MM-DD HH:MM:SS.fff'. */
export function chDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * The wholesale customer-scope CTE — drops staff + creators by role (and the
 * excluded-users blacklist when present), mirroring `realUsersCte` in
 * window-metrics.ts / dashboard-cashflow.ts. The session-window creator
 * carve-out is intentionally OMITTED: creators are excluded wholesale here, so
 * there is nothing left for it to exclude. The default CTE name is `real_users`
 * and the blacklist binds to the `{blacklist:Array(String)}` query param.
 */
export function customerScopeCte(opts: {
  hasBlacklist: boolean;
  alias?: string;
}): string {
  const alias = opts.alias ?? "real_users";
  return `${alias} AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support','creator')
        ${opts.hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

/**
 * Creator-inventory carve-out predicate (ClickHouse twin of
 * `nonCreatorOwnerSql` in `queries/_creator-pnl-exclusion.ts`). Keeps an
 * inventory row ONLY if its owner is not a creator — applied to the
 * `inventoryChange` leg of the dashboard P&L twins (windowed / daily /
 * net-holdings movers / stats) so the CH-served figures match the Postgres
 * house-P&L formula, which drops creator inventory from the liability term.
 * Balance + voucher legs are unaffected. `userIdCol` is the row's user-id
 * column, e.g. `ui.user_id`.
 */
export function nonCreatorOwnerCh(userIdCol: string): string {
  return `${userIdCol} NOT IN (SELECT id FROM ${CH_DB}.public_user FINAL WHERE _peerdb_is_deleted = 0 AND role = 'creator')`;
}

export { toNumber } from "@/lib/utils/decimal";
