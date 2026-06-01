import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";

/**
 * Runtime schema probe for the /insights/streamers data layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * The streamer-insights queries are raw SQL that references enum values
 * and tables which may or may not be present depending on WHICH database
 * the request is connected to:
 *
 *   • Production (packy.gg) has migrated past the upgrader launch, so the
 *     `ledger_transaction_type` enum carries `upgrader_bet` /
 *     `upgrader_payout` and the `upgrader_games`, `fingerprints`,
 *     `creator_sessions` tables exist.
 *   • Some snapshots / dev databases predate those migrations. There the
 *     enum is missing those two members and the tables don't exist.
 *
 * Raw SQL that hard-codes those names then explodes on the older DB:
 *   • `type IN ('upgrader_bet', …)` where `type` is the enum column →
 *     Postgres coerces the literal to the enum and throws
 *     `22P02 invalid input value for enum`.
 *   • `… FROM upgrader_games` → `42P01 relation does not exist`.
 *
 * The page reported broken three times for exactly this reason: a single
 * such throw inside a tab query cascades to the tab's safeQuery fallback
 * and the operator sees "Couldn't load this section".
 *
 * THE FIX
 * -------
 * Introspect the CONNECTED database ONCE (cached 5 min) and let every
 * query adapt:
 *   • Filter desired ledger `type IN (...)` lists down to the members the
 *     enum actually has (`safeLedgerTypeInList`) — so on prod the list
 *     includes `upgrader_bet`, on an old snapshot it silently omits it.
 *     Neither throws.
 *   • Skip a whole signal when its required table is absent
 *     (`if (!probe.hasUpgraderGames) …`).
 *
 * The result: the page WORKS on a stale snapshot AND on migrated prod,
 * with no schema assumptions baked into the SQL.
 *
 * READ-ONLY. The probe only reads `pg_enum` / `pg_type` and calls
 * `to_regclass` — no writes, no game-data access. Safe against both the
 * stale local DB and live production.
 */

const TTL_SECONDS = 300;

export type StreamerSchemaProbe = {
  /** Every member present in the `ledger_transaction_type` enum on the
   *  connected DB. Use `safeLedgerTypeInList` to intersect a desired
   *  list against this set before interpolating it into raw SQL. */
  ledgerTypes: Set<string>;
  /** Members present in `affiliate_usage_type` (deposit / wager /
   *  signup on prod; some snapshots lack `signup`). All streamer
   *  queries compare `usage_type::text` against literals, so a missing
   *  member is harmless — this is exposed for completeness / future
   *  callers that want a bare-enum comparison. */
  affiliateUsageTypes: Set<string>;
  /** `upgrader_games` table — gates the upgrader hit-rate sub-signal. */
  hasUpgraderGames: boolean;
  /** `fingerprints` table — gates any device-fingerprint signal. */
  hasFingerprints: boolean;
  /** `creator_sessions` table — gates any on-stream signal that would
   *  read sessions from the main DB directly (the current self-play
   *  signal reads sessions from the backend creators API, not this
   *  table, but the probe carries the flag so a future query can gate
   *  on it without re-introspecting). */
  hasCreatorSessions: boolean;
  /** `race_claims` table — gates the code-switching race cross-reference
   *  and the entire leaderboard-sniper tab. */
  hasRaceClaims: boolean;
  /** `affiliate_code_usages` table — the spine of every streamer query.
   *  When absent the whole page degrades to empty (no cohorts to
   *  analyse) rather than throwing. */
  hasAffiliateCodeUsages: boolean;
  /** `user_inventory` table — gates the pack-RTP payout side + the
   *  overview card-withdrawal attribution. */
  hasUserInventory: boolean;
  /** `vouchers` table — gates the voucher leg of overview card WD. */
  hasVouchers: boolean;
  /** `card_withdrawal_requests` table — gates overview card WD entirely. */
  hasCardWithdrawalRequests: boolean;
  /** `battles` table — gates the borrow-share abuse signal. */
  hasBattles: boolean;
  /** `balances` table — gates the inactive-cohort abuse signal. */
  hasBalances: boolean;
};

async function probe(): Promise<StreamerSchemaProbe> {
  const db = await getDb();

  // ── Enum members ────────────────────────────────────────────────
  // pg_enum join is the canonical way to list a Postgres enum's labels.
  // Both reads are wrapped so a single introspection failure degrades
  // to an empty set (every desired-list intersection then yields the
  // empty list → the dependent query returns zeros instead of throwing
  // — the same safe degradation as a missing member).
  let ledgerTypes = new Set<string>();
  let affiliateUsageTypes = new Set<string>();
  try {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'ledger_transaction_type'`;
    ledgerTypes = new Set(rows.map((r) => r.enumlabel));
  } catch (err) {
    logProbeFailure("ledger_transaction_type enum", err);
  }
  try {
    const rows = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'affiliate_usage_type'`;
    affiliateUsageTypes = new Set(rows.map((r) => r.enumlabel));
  } catch (err) {
    logProbeFailure("affiliate_usage_type enum", err);
  }

  // ── Table presence via to_regclass ──────────────────────────────
  // to_regclass returns NULL (not an error) for a missing relation, so
  // this never throws on an absent table — exactly what we want for a
  // probe. One round-trip per table; the small fixed set is cached for
  // 5 minutes so this is cheap.
  const tableExists = async (name: string): Promise<boolean> => {
    try {
      const r = await db.$queryRaw<{ exists: string | null }[]>`
        SELECT to_regclass(${"public." + name})::text AS exists`;
      return r[0]?.exists != null;
    } catch (err) {
      logProbeFailure(`to_regclass(${name})`, err);
      // On an introspection error, assume ABSENT so dependent signals
      // skip rather than risk a throw on the real query.
      return false;
    }
  };

  const [
    hasUpgraderGames,
    hasFingerprints,
    hasCreatorSessions,
    hasRaceClaims,
    hasAffiliateCodeUsages,
    hasUserInventory,
    hasVouchers,
    hasCardWithdrawalRequests,
    hasBattles,
    hasBalances,
  ] = await Promise.all([
    tableExists("upgrader_games"),
    tableExists("fingerprints"),
    tableExists("creator_sessions"),
    tableExists("race_claims"),
    tableExists("affiliate_code_usages"),
    tableExists("user_inventory"),
    tableExists("vouchers"),
    tableExists("card_withdrawal_requests"),
    tableExists("battles"),
    tableExists("balances"),
  ]);

  return {
    ledgerTypes,
    affiliateUsageTypes,
    hasUpgraderGames,
    hasFingerprints,
    hasCreatorSessions,
    hasRaceClaims,
    hasAffiliateCodeUsages,
    hasUserInventory,
    hasVouchers,
    hasCardWithdrawalRequests,
    hasBattles,
    hasBalances,
  };
}

function logProbeFailure(what: string, reason: unknown): void {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(
    `[insights-streamers.schema-probe] introspecting '${what}' failed, treating as absent: ${msg}`,
  );
}

const cached = unstable_cache(probe, ["insights-streamers-schema-probe-v1"], {
  revalidate: TTL_SECONDS,
  tags: ["insights-streamers"],
});

/**
 * The single entry point. Returns the (cross-request cached) snapshot of
 * what the connected DB actually has. Call once per query and pass the
 * result into the helpers below.
 */
export function getStreamerSchemaProbe(): Promise<StreamerSchemaProbe> {
  return cached();
}

/**
 * Intersect a desired set of ledger-type names with the members the
 * connected enum actually has, and render the result as a parenthesised,
 * single-quoted SQL list ready to drop after `IN`:
 *
 *   const w = safeLedgerTypeInList(probe, WAGER_PAYOUT_WAGER_TYPES);
 *   if (w === null) return zero;            // nothing usable → skip
 *   `… WHERE type IN ${w}`                  // never throws
 *
 * Returns `null` when NONE of the desired members exist (so the caller
 * can skip the query entirely instead of emitting `IN ()`, which is a
 * syntax error). The values are hardcoded ledger-type strings filtered
 * against the live enum — no external input, injection is structurally
 * impossible.
 *
 * Because every emitted literal is guaranteed to be a real member of the
 * connected enum, the resulting `type IN (...)` is safe to use as a
 * BARE-ENUM comparison (no `::text` cast needed), which lets Postgres use
 * the enum index.
 */
export function safeLedgerTypeInList(
  probe: StreamerSchemaProbe,
  desired: readonly string[],
): string | null {
  const present = desired.filter((t) => probe.ledgerTypes.has(t));
  if (present.length === 0) return null;
  return `(${present.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`;
}
