import { getDb } from "@/lib/db";

/**
 * Which of a set of `rakeback_claim` ledger rows were INSTANT (early) claims.
 *
 * Signal
 * ──────
 * There is only ONE ledger type for rakeback (`rakeback_claim`) — instant and
 * regular claims look identical on `ledger_transactions`. The distinguisher
 * lives on the game DB's `rakeback_claims` table: a non-NULL `last_preclaim_at`
 * means that claim used the instant/early-claim flow. Each `rakeback_claims`
 * row links back to its ledger entry via `ledger_tx_id`. So: given a page of
 * `rakeback_claim` ledger ids, the ones whose `rakeback_claims` row has a
 * non-NULL `last_preclaim_at` are the instant claims.
 *
 * COLUMN PROBE (defensive)
 * ────────────────────────
 * The early-claim feature is LIVE on prod: `rakeback_claims.last_preclaim_at`
 * exists on the live PROD game DB and flags real instant claims there
 * (verified read-only, 2026-06-14). It is present on dev too. The committed
 * `prisma/schema.prisma` does NOT carry the column, though, so the typed
 * Prisma client cannot reference it. We therefore PROBE
 * `information_schema.columns` first and return an EMPTY set only if the
 * column is ever absent on the active env (e.g. an unmigrated dev DB), so
 * rows degrade to the plain "Rakeback" label instead of throwing 42703. The
 * probe is defensive — on prod it always returns the column. Same pattern as
 * `rakeback-instant-claim.ts`.
 *
 * READ-ONLY. No mutations.
 */
export async function getInstantRakebackLedgerTxIds(
  ledgerTxIds: readonly string[],
): Promise<Set<string>> {
  if (ledgerTxIds.length === 0) return new Set();

  const db = await getDb();

  // Probe the gating column once (defensive — present on prod and dev;
  // guards an unmigrated env).
  const colRows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'rakeback_claims'
         AND column_name = 'last_preclaim_at'
    ) AS exists`;
  if (colRows[0]?.exists !== true) return new Set();

  // Pull the ledger ids whose linked rakeback_claims row was early-claimed.
  // `ledger_tx_id` is a uuid column, so cast the bound array to uuid[]
  // (a text[] cast throws `operator does not exist: uuid = text`). Return the
  // matched ids as text so they compare against the string ledger ids the
  // caller holds.
  const rows = await db.$queryRaw<{ ledger_tx_id: string }[]>`
    SELECT ledger_tx_id::text AS ledger_tx_id
      FROM rakeback_claims
     WHERE ledger_tx_id = ANY(${[...ledgerTxIds]}::uuid[])
       AND last_preclaim_at IS NOT NULL`;

  return new Set(rows.map((r) => r.ledger_tx_id));
}

/**
 * Which of a set of `rakeback_claims` rows (by their OWN `id`) were instant
 * (early) claims. Same drift guard + signal as
 * {@link getInstantRakebackLedgerTxIds}, but keyed on the claim's primary key
 * for callers (the /rewards/rakeback claims table) that already hold the
 * `rakeback_claims.id` rather than the ledger id.
 *
 * READ-ONLY.
 */
export async function getInstantRakebackClaimIds(
  claimIds: readonly string[],
): Promise<Set<string>> {
  if (claimIds.length === 0) return new Set();

  const db = await getDb();

  const colRows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'rakeback_claims'
         AND column_name = 'last_preclaim_at'
    ) AS exists`;
  if (colRows[0]?.exists !== true) return new Set();

  // `rakeback_claims.id` is a uuid column — cast the bound array to uuid[].
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM rakeback_claims
     WHERE id = ANY(${[...claimIds]}::uuid[])
       AND last_preclaim_at IS NOT NULL`;

  return new Set(rows.map((r) => r.id));
}
