import { unstable_cache } from "next/cache";
import {
  ledger_transaction_type,
  type ledger_transaction_type as LedgerTransactionType,
} from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";

/** Generated Prisma enum values — keep queries in sync with schema.prisma. */
export const LEDGER_TX_TYPES = new Set<string>(Object.values(ledger_transaction_type));

/** Drop strings that are not in the generated client (e.g. after schema drift before `prisma generate`). */
export function filterLedgerTxTypes(types: readonly string[]): LedgerTransactionType[] {
  return types.filter((t): t is LedgerTransactionType => LEDGER_TX_TYPES.has(t));
}

/**
 * Live `ledger_transaction_type` enum members on the CONNECTED database.
 *
 * WHY: the generated Prisma client (and `prisma/schema.prisma`) is AHEAD of
 * prod for the not-yet-launched upgrader feature — it carries `upgrader_bet`
 * / `upgrader_payout`, but the prod enum does NOT have those members yet.
 * Passing a value the live enum lacks into a Prisma `type: { in: [...] }`
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
  async (): Promise<string[]> => {
    const db = await getDb();
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'ledger_transaction_type'`;
    return rows.map((r) => r.enumlabel);
  },
  ["live-ledger-tx-enum-v1"],
  { revalidate: 300 },
);

async function getLiveLedgerTxTypes(): Promise<Set<string>> {
  try {
    const labels = await liveLedgerEnumCached();
    // Defensive: an empty result (introspection returned nothing) would
    // strip EVERY type and silently empty every list — fall back to the
    // generated set in that case rather than degrade to "no types".
    if (labels.length === 0) return LEDGER_TX_TYPES;
    return new Set(labels);
  } catch (err) {
    console.error(
      "[_ledger-tx-types] live enum probe failed, falling back to generated set:",
      err instanceof Error ? err.message : err,
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
