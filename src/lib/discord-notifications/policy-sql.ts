import "server-only";

import { sql, type SQL } from "drizzle-orm";

import {
  APPROVED_DISCORD_CATEGORY_IDS,
  SILENT_DISCORD_CATEGORY_IDS,
} from "./antifraud-policy";

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * The category allowlist as a parameterised `IN (...)` list, so adding a
 * category is a one-line change in `antifraud-policy.ts` instead of an edit in
 * every routing query.
 */
export function approvedCategoryIds(): SQL {
  return idList(APPROVED_DISCORD_CATEGORY_IDS);
}

export function silentCategoryIds(): SQL {
  return idList(SILENT_DISCORD_CATEGORY_IDS);
}
