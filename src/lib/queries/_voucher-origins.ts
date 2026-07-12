import { unstable_cache } from "next/cache";
import {
  voucher_origin,
  type voucher_origin as VoucherOrigin,
} from "@/generated/prisma/enums";
import { dbForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";

/** Generated Prisma `voucher_origin` members — keep in sync with schema.prisma. */
const VOUCHER_ORIGINS = new Set<string>(Object.values(voucher_origin));

/** Drop strings not in the generated client (schema drift before `prisma generate`). */
function filterVoucherOrigins(origins: readonly string[]): VoucherOrigin[] {
  return origins.filter((o): o is VoucherOrigin => VOUCHER_ORIGINS.has(o));
}

/**
 * Live `voucher_origin` enum members on the CONNECTED database.
 *
 * Same drift guard as `_ledger-tx-types.ts` `filterLedgerTxTypesLive`: the
 * generated client may carry a member the live DB lacks (or vice-versa).
 * A bare `origin IN ('x'::voucher_origin, …)` would throw `22P02 invalid
 * input value for enum` if a literal is absent from the live enum — taking
 * the whole query down. We must use the NATIVE enum form (not `::text`) so
 * the `idx_vouchers_origin_created_at` index is used, so this probe keeps
 * that form safe by only ever emitting members the live enum actually has.
 *
 * Cached 5 min, keyed on the prod/dev toggle. READ-ONLY (introspects
 * `pg_enum` / `pg_type`). On failure it falls back to the generated set.
 */
const liveVoucherOriginEnumCached = unstable_cache(
  async (env: DbEnv): Promise<string[]> => {
    const db = dbForEnv(env);
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'voucher_origin'`;
    return rows.map((r) => r.enumlabel);
  },
  ["live-voucher-origin-enum-v1"],
  { revalidate: 300 },
);

async function getLiveVoucherOrigins(): Promise<Set<string>> {
  try {
    const env = await readDbEnv();
    const labels = await liveVoucherOriginEnumCached(env);
    if (labels.length === 0) return VOUCHER_ORIGINS;
    return new Set(labels);
  } catch (err) {
    console.error(
      "[_voucher-origins] live enum probe failed, falling back to generated set:",
      err instanceof Error ? err.message : err,
    );
    return VOUCHER_ORIGINS;
  }
}

/**
 * Like `filterVoucherOrigins`, but additionally drops any member the LIVE
 * (connected) enum lacks — so an `origin IN ('x'::voucher_origin, …)` built
 * from the result can never throw `22P02` on a migration-lagged DB while
 * still using the native enum form the index needs.
 */
export async function filterVoucherOriginsLive(
  origins: readonly string[],
): Promise<VoucherOrigin[]> {
  const generated = filterVoucherOrigins(origins);
  const live = await getLiveVoucherOrigins();
  return generated.filter((o) => live.has(o));
}
