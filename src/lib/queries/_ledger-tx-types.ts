import { unstable_cache } from "next/cache";
import { sql } from "drizzle-orm";
import { ledger_transaction_type } from "@/lib/db-schema/main/schema";
import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { logWarn } from "@/lib/errors/logger";

/** Ledger enum values — keep queries in sync with the database schema. */
export type LedgerTransactionType =
  (typeof ledger_transaction_type.enumValues)[number];
const LEDGER_TX_TYPES = new Set<string>(ledger_transaction_type.enumValues);

/** Drop strings that are not in the checked-in enum snapshot after schema drift. */
export function filterLedgerTxTypes(
  types: readonly string[],
): LedgerTransactionType[] {
  return types.filter((t): t is LedgerTransactionType =>
    LEDGER_TX_TYPES.has(t),
  );
}

/**
 * Live `ledger_transaction_type` enum members on the CONNECTED database.
 *
 * WHY: the application schema can be ahead of
 * prod for the not-yet-launched upgrader feature — it carries `upgrader_bet`
 * / `upgrader_payout`, but the prod enum does NOT have those members yet.
 * Passing a value the live enum lacks into an `IN` predicate
 * (or any bare `type IN (...)` SQL) makes Postgres coerce the literal to the
 * enum and throw `22P02 invalid input value for enum` — which takes the WHOLE
 * query down. (This is the same drift the streamer-insights layer already
 * guards via `insights-streamers/_schema-probe.ts` `safeLedgerTypeInList`.)
 *
 * So `filterLedgerTxTypes` (generated-set) is NOT enough on its own: it only
 * drops members BEHIND the generated client, not members the generated client
 * has but the live DB lacks. This probe closes that gap and self-heals once a
 * prod migration adds the member.
 *
 * Cached 5 min, keyed on the prod/dev DB toggle so the two DBs don't share an
 * entry. READ-ONLY: introspects `pg_enum` / `pg_type` only. On a probe failure
 * it returns the generated set (fail-OPEN to the schema) rather than crashing
 * — the worst case then degrades to the pre-existing behaviour.
 */
const liveLedgerEnumCached = unstable_cache(
  // `env` is passed as an ARGUMENT (not read from the cookie inside the
  // callback) so it becomes part of the cache key — prod and dev get
  // separate entries. Reading the cookie inside `unstable_cache` throws (no
  // request scope) and `readDbEnv` then silently falls back to "prod", which
  // poisoned a dev-toggled request with the PROD enum and dropped dev-only
  // ledger types. Use the explicit `readDrizzleForEnv(env)` for the same reason.
  async (env: DbEnv): Promise<string[]> => {
    const db = readDrizzleForEnv(env);
    const result = await db.execute<{ enumlabel: string }>(sql`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'ledger_transaction_type'
    `);
    return result.rows.map((r) => r.enumlabel);
  },
  ["live-ledger-tx-enum-v2"],
  { revalidate: 300 },
);

async function getLiveLedgerTxTypes(): Promise<Set<string>> {
  try {
    // Resolve the env OUTSIDE the cache (in request scope) and pass it in, so
    // the cached entry is keyed per env — the established pattern in
    // `users-detail-cache.ts`.
    const env = await readDbEnv();
    const labels = await liveLedgerEnumCached(env);
    // Defensive: an empty result (introspection returned nothing) would
    // strip EVERY type and silently empty every list — fall back to the
    // generated set in that case rather than degrade to "no types".
    if (labels.length === 0) return LEDGER_TX_TYPES;
    return new Set(labels);
  } catch (err) {
    logWarn(
      "ledger-tx-types.enum-probe",
      "live enum probe failed; using generated set",
      err,
    );
    return LEDGER_TX_TYPES;
  }
}

/**
 * Like `filterLedgerTxTypes`, but additionally drops any member the LIVE
 * (connected) enum does not have — so a `type: { in: [...] }` built from the
 * result can never throw `22P02` on a migration-lagged DB. Use this for any
 * runtime query whose desired type list may include not-yet-migrated members
 * (e.g. the upgrader types in the user-detail Gaming feed).
 */
export async function filterLedgerTxTypesLive(
  types: readonly string[],
): Promise<LedgerTransactionType[]> {
  const generated = filterLedgerTxTypes(types);
  const live = await getLiveLedgerTxTypes();
  return generated.filter((t) => live.has(t));
}

/**
 * Narrow a single requested type to `null` when the LIVE enum lacks it, so a
 * scalar `where.type = <value>` filter can be skipped instead of throwing.
 */
export async function isLiveLedgerTxType(type: string): Promise<boolean> {
  if (!LEDGER_TX_TYPES.has(type)) return false;
  const live = await getLiveLedgerTxTypes();
  return live.has(type);
}
