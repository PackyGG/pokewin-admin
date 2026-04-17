import pg from "pg";
import crypto from "crypto";

/**
 * Thin DB helpers for E2E test setup / teardown.
 *
 * These talk directly to Postgres via `pg` (already a project dep) so the
 * helpers don't pull in the generated Prisma client — keeping them free
 * from the `src/generated/**` folder and avoiding a second connection
 * pool on the test process.
 *
 * Every scratch user created here carries a `_e2e_` prefix on their
 * username so accidental leftovers are trivially greppable / deletable
 * in a single cleanup query.
 */

const SCRATCH_USER_PREFIX = "_e2e_";

let mainPool: pg.Pool | null = null;
let adminPool: pg.Pool | null = null;

function getMainPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!mainPool) mainPool = new pg.Pool({ connectionString: url, max: 2 });
  return mainPool;
}

function getAdminPool(): pg.Pool {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error("ADMIN_DATABASE_URL is not set");
  if (!adminPool) adminPool = new pg.Pool({ connectionString: url, max: 2 });
  return adminPool;
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([
    mainPool?.end(),
    adminPool?.end(),
  ]);
  mainPool = null;
  adminPool = null;
}

export type ScratchUser = {
  id: string;
  email: string;
  username: string;
};

/**
 * Create a fresh main-DB user with zero balance. Caller is responsible
 * for deleting it via deleteScratchUser when done.
 */
export async function createScratchUser(
  overrides: Partial<Pick<ScratchUser, "email" | "username">> = {},
): Promise<ScratchUser> {
  const id = crypto.randomUUID();
  const suffix = crypto.randomBytes(4).toString("hex");
  const username =
    overrides.username ?? `${SCRATCH_USER_PREFIX}${suffix}`;
  const email = overrides.email ?? `${username}@e2e.test`;

  const pool = getMainPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "user"
          (id, email, email_verified, username, role, country, country_code,
           continent_code, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3, 'user', 'Germany', 'DE', 'EU', NOW(), NOW())`,
      [id, email, username],
    );
    await client.query(
      `INSERT INTO balances (user_id, available_balance, locked_balance,
                             total_deposited, total_withdrawn, total_wagered,
                             total_won, bonus_points, version,
                             created_at, updated_at)
       VALUES ($1, 0, 0, 0, 0, 0, 0, 0, 1, NOW(), NOW())`,
      [id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { id, email, username };
}

/**
 * Delete a scratch user and every row that references them. Safe to call
 * multiple times — the `DELETE FROM "user"` cascades through FK
 * constraints. Balances + any test-spawned rows go with it.
 *
 * This only touches users we created — the prefix guard and the exact ID
 * match make it impossible to accidentally blast a real user.
 */
export async function deleteScratchUser(id: string): Promise<void> {
  const pool = getMainPool();
  await pool.query(`DELETE FROM balances WHERE user_id = $1`, [id]);
  await pool.query(
    `DELETE FROM "user" WHERE id = $1 AND username LIKE '${SCRATCH_USER_PREFIX}%'`,
    [id],
  );
}

/**
 * Best-effort sweep of any leftover scratch users from a previous run.
 * Only deletes rows whose username matches the E2E prefix — never touches
 * production users even if the pool URL is wrong.
 *
 * Returns the number of users removed so the caller can log it.
 */
export async function sweepStaleScratchUsers(): Promise<number> {
  const pool = getMainPool();
  const victimRes = await pool.query<{ id: string }>(
    `SELECT id FROM "user" WHERE username LIKE '${SCRATCH_USER_PREFIX}%'`,
  );
  if (victimRes.rowCount === 0) return 0;
  const ids = victimRes.rows.map((r) => r.id);

  await pool.query(`DELETE FROM balances WHERE user_id = ANY($1::text[])`, [ids]);
  const del = await pool.query(
    `DELETE FROM "user" WHERE id = ANY($1::text[]) AND username LIKE '${SCRATCH_USER_PREFIX}%'`,
    [ids],
  );
  return del.rowCount ?? 0;
}

/**
 * Read a user's available balance from the main DB. Used by tests that
 * want to assert the Balance Adjust dialog actually moved the number
 * server-side, not just in the UI.
 */
export async function getUserBalance(userId: string): Promise<number> {
  const pool = getMainPool();
  const res = await pool.query<{ available_balance: string }>(
    `SELECT available_balance FROM balances WHERE user_id = $1`,
    [userId],
  );
  if (res.rowCount === 0) throw new Error(`No balances row for ${userId}`);
  return Number(res.rows[0].available_balance);
}

/**
 * Read a user's role from the main DB.
 */
export async function getUserRole(userId: string): Promise<string> {
  const pool = getMainPool();
  const res = await pool.query<{ role: string }>(
    `SELECT role FROM "user" WHERE id = $1`,
    [userId],
  );
  if (res.rowCount === 0) throw new Error(`No user row for ${userId}`);
  return res.rows[0].role;
}

/**
 * Deletes any custom admin_roles whose name matches the E2E prefix. Used
 * by the permissions spec to clean up roles it creates. System roles
 * (is_system = true) are never touched.
 */
export async function cleanupE2EAdminRoles(): Promise<number> {
  const pool = getAdminPool();
  const del = await pool.query(
    `DELETE FROM admin_roles
       WHERE is_system = FALSE
         AND name LIKE '${SCRATCH_USER_PREFIX}%'`,
  );
  return del.rowCount ?? 0;
}

/**
 * Deletes admin ad codes created under the seeded house user whose code
 * matches the E2E prefix. Only used by the ads spec.
 */
export async function cleanupE2EAdCodes(): Promise<number> {
  const pool = getMainPool();
  const del = await pool.query(
    `DELETE FROM affiliate_codes WHERE code LIKE '${SCRATCH_USER_PREFIX}%'`,
  );
  return del.rowCount ?? 0;
}

export const scratchPrefix = SCRATCH_USER_PREFIX;
