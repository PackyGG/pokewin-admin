import "server-only";

import { sql } from "drizzle-orm";
import type { MainDrizzleDb } from "@/lib/db";

// Hard ceiling on the JSON blob we persist into admin_deleted_users.
// Postgres JSONB can technically hold much more, but a single user with
// 250k+ ledger rows would otherwise generate a multi-hundred-MB blob and
// stall the dashboard. 5 MB matches the same conservative cap the
// audit-event metadata uses elsewhere.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

// Per-collection cap. Even within the byte ceiling we don't want a
// snapshot full of a single user's 100k game sessions; we slice the
// newest N of each unbounded collection so restore at least has the
// recent context.
const HISTORICAL_ROW_CAP = 1000;

/**
 * Shape of the JSONB blob stored in `admin_deleted_users.snapshot`.
 *
 * Decimal / Date / BigInt values in the main DB serialize to:
 *   - Decimal → string (numeric columns are selected as canonical text).
 *   - Date    → ISO string (default JSON.stringify behaviour).
 *   - BigInt  → not used on the snapshotted models, but if encountered
 *     we coerce to string via the replacer below to avoid throwing.
 *
 * Restore reads each section back, binds decimal/date strings through
 * parameterized SQL, and runs a Drizzle transaction — see
 * src/app/(admin)/users/deleted/actions.ts.
 */
export type DeletedUserSnapshot = {
  user: Record<string, unknown>;
  balances: Record<string, unknown> | null;
  user_inventory: Array<Record<string, unknown>>;
  vouchers: Array<Record<string, unknown>>;
  rakeback_claims: Array<Record<string, unknown>>;
  // Historical-only — captured for human review, never re-inserted on
  // restore because the parent rows (game_sessions ↔ ledger ↔ deposit
  // addresses) would foreign-key crash. Caps at HISTORICAL_ROW_CAP.
  game_sessions: Array<Record<string, unknown>>;
  ledger_transactions: Array<Record<string, unknown>>;
  // Names of any collections we had to truncate to keep the JSONB blob
  // under MAX_SNAPSHOT_BYTES. Surfaced in the UI so an admin
  // restoring a heavy user knows what to expect.
  _truncated: string[];
};

// JSON.stringify replacer: keep Decimal.js / BigInt values addressable
// after a JSON round-trip. Decimal.js instances expose `toFixed()`; without
// this they serialize as their internal shape, which restore cannot parse.
function snapshotJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (
    value !== null &&
    typeof value === "object" &&
    "toFixed" in value &&
    typeof (value as { toFixed: unknown }).toFixed === "function" &&
    "s" in value &&
    "e" in value &&
    "d" in value
  ) {
    // decimal.js Decimal instance — render the canonical decimal string.
    return (value as { toFixed: () => string }).toFixed();
  }
  return value;
}

/**
 * Estimate the byte length of a JS value once it's been encoded as the
 * canonical snapshot JSON. We need the post-encode size because Decimal
 * instances shrink dramatically once we collapse them to a single
 * string (via the replacer above).
 */
function snapshotByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, snapshotJsonReplacer), "utf8");
}

/**
 * Build the snapshot blob for `userId`. All reads run in parallel; the
 * `user` row is mandatory (caller already verified the user exists via
 * findUnique before calling — we re-fetch to capture the full row).
 *
 * The size guard runs after we've assembled the in-memory object:
 *   1. Cap each unbounded historical collection at HISTORICAL_ROW_CAP.
 *   2. If the encoded size still exceeds MAX_SNAPSHOT_BYTES, drop the
 *      heaviest historical arrays one by one (ledger_transactions
 *      first, then game_sessions) and record the truncation marker.
 *   3. If we're STILL over budget after dropping both, drop
 *      user_inventory too (some users have 200k inventory rows in the
 *      worst case). Inventory is restorable — we'd rather restore the
 *      user without it than fail the snapshot entirely.
 *
 * Returns the assembled snapshot. Throws only if the mandatory `user`
 * row is missing — the caller must abort the delete in that case.
 */
export async function buildUserSnapshot(
  db: Pick<MainDrizzleDb, "execute">,
  userId: string,
): Promise<DeletedUserSnapshot> {
  const [
    userRow,
    balancesRow,
    inventoryRows,
    vouchersRows,
    rakebackRows,
    gameSessionsRows,
    ledgerRows,
  ] = await Promise.all([
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(u) AS row FROM "user" u WHERE id = ${userId}
    `).then((result) => result.rows[0]?.row ?? null),
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(b) || jsonb_build_object(
        'available_balance', b.available_balance::text,
        'locked_balance', b.locked_balance::text,
        'total_deposited', b.total_deposited::text,
        'total_withdrawn', b.total_withdrawn::text,
        'total_wagered', b.total_wagered::text,
        'total_won', b.total_won::text
      ) AS row
      FROM balances b WHERE user_id = ${userId}
    `).then((result) => result.rows[0]?.row ?? null),
    // Newest first so the truncation cap keeps the most recent rows.
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(ui) || jsonb_build_object(
        'value_at_obtained', ui.value_at_obtained::text,
        'pull_chance', ui.pull_chance::text
      ) AS row FROM user_inventory ui
      WHERE user_id = ${userId} ORDER BY created_at DESC
    `).then((result) => result.rows.map((row) => row.row)),
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(v) || jsonb_build_object('value', v.value::text) AS row
      FROM vouchers v
      WHERE user_id = ${userId} ORDER BY created_at DESC
    `).then((result) => result.rows.map((row) => row.row)),
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(rc) || jsonb_build_object(
        'wagered_amount_usd', rc.wagered_amount_usd::text,
        'rakeback_amount_usd', rc.rakeback_amount_usd::text
      ) AS row FROM rakeback_claims rc
      WHERE user_id = ${userId} ORDER BY created_at DESC
    `).then((result) => result.rows.map((row) => row.row)),
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(gs) AS row FROM game_sessions gs
      WHERE user_id = ${userId} ORDER BY created_at DESC
      LIMIT ${HISTORICAL_ROW_CAP}
    `).then((result) => result.rows.map((row) => row.row)),
    db.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(lt) AS row FROM ledger_transactions lt
      WHERE user_id = ${userId} ORDER BY created_at DESC
      LIMIT ${HISTORICAL_ROW_CAP}
    `).then((result) => result.rows.map((row) => row.row)),
  ]);

  if (!userRow) {
    throw new Error(`Cannot snapshot — user ${userId} not found in main DB`);
  }

  const snapshot: DeletedUserSnapshot = {
    user: userRow as unknown as Record<string, unknown>,
    balances: balancesRow as unknown as Record<string, unknown> | null,
    user_inventory: inventoryRows as unknown as Array<Record<string, unknown>>,
    vouchers: vouchersRows as unknown as Array<Record<string, unknown>>,
    rakeback_claims: rakebackRows as unknown as Array<Record<string, unknown>>,
    game_sessions: gameSessionsRows as unknown as Array<Record<string, unknown>>,
    ledger_transactions: ledgerRows as unknown as Array<Record<string, unknown>>,
    _truncated: [],
  };

  // Size guard — progressively shed historical / inventory data until
  // we're under the byte cap. Order matters: ledger > sessions >
  // inventory in terms of what we'd rather lose first.
  const drops: Array<{ key: keyof DeletedUserSnapshot; label: string }> = [
    { key: "ledger_transactions", label: "ledger_transactions" },
    { key: "game_sessions", label: "game_sessions" },
    { key: "user_inventory", label: "user_inventory" },
  ];

  for (const { key, label } of drops) {
    if (snapshotByteLength(snapshot) <= MAX_SNAPSHOT_BYTES) break;
    // Reassign with empty array to keep TS happy across keys.
    (snapshot as unknown as Record<string, unknown[]>)[key as string] = [];
    snapshot._truncated.push(label);
  }

  return snapshot;
}

/**
 * Convert the snapshot to a JSON-safe structure by round-tripping through the
 * replacer. The result is
 * (Decimal → string, BigInt → string, Date → ISO string) and ready to
 * hand directly to the admin deleted-users insert.
 */
export function snapshotToJsonValue(
  snapshot: DeletedUserSnapshot,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(snapshot, snapshotJsonReplacer),
  ) as Record<string, unknown>;
}
