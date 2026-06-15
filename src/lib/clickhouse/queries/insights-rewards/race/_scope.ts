import "server-only";

import { CH_DB } from "../../_shared";

/**
 * 2-role customer-scope CTE for the race-insights legs.
 *
 * Mirrors the EXACT scope the PG twins under
 * `src/lib/queries/insights-rewards/race/*` use:
 * `u.role NOT IN ('admin','support')` (creators are KEPT here — this is the
 * 2-role exclusion, NOT the wholesale 3-role `customerScopeCte`) plus the
 * dynamic `excluded_users` blacklist via `blacklistNotInClause`. Keeping it
 * inline (rather than reusing `customerScopeCte`) is required by the per-surface
 * scope rule (clickhouse-rules.md §6b): a CH twin replicates whatever scope its
 * specific PG twin uses so comparison drift cleanly signals a real bug.
 *
 * The default CTE name is `real_users`; the blacklist binds to the
 * `{blacklist:Array(String)}` query param.
 */
export function raceScopeCte(
  hasBlacklist: boolean,
  alias = "real_users",
): string {
  return `${alias} AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}
