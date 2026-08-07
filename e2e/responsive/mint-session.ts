import pg from "pg";
import { SignJWT } from "jose";

/**
 * Headless-auth helper for the RESPONSIVE audit harness only.
 *
 * Why this departs from the rest of e2e/ (which logs in through the real
 * /login + 2FA forms, see e2e/README.md "no faked session cookies"):
 *
 *   The responsive audit renders ~84 routes × ~10 viewports = hundreds of
 *   navigations per run. Driving the real 2FA login form for every one of
 *   those contexts would dominate the runtime and add a TOTP-clock flake
 *   surface that has nothing to do with what this harness measures
 *   (rendered layout geometry). The auth/permission *behaviour* is already
 *   covered by auth.spec.ts / permissions.spec.ts through the real forms.
 *
 *   So here — and ONLY here — we mint the same `admin_session` JWT the app
 *   issues after a successful login and inject it as a cookie. This is NOT
 *   an auth bypass route in the app: `src/middleware.ts` still decrypts the
 *   cookie and checks its expiry exactly as it would for a real session.
 *   A minted cookie that doesn't verify against SESSION_SECRET, or whose
 *   expiresAt is in the past, is rejected and the harness redirects to
 *   /login (the spec fails loud on that).
 *
 * Everything below mirrors src/lib/session.ts EXACTLY:
 *   - cookie name        : "admin_session"
 *   - payload keys       : { userId, role, roles, email, username, expiresAt }
 *   - signing alg        : HS256, key = TextEncoder().encode(SESSION_SECRET)
 *   - setIssuedAt() + setExpirationTime("12h")
 *   - expiresAt          : a Date 12h out (middleware does
 *                          `new Date(session.expiresAt) > new Date()`)
 *
 * The admin identity is read READ-ONLY from the ADMIN DB — one is_active
 * admin row. No writes, no migrations. Matches the dual-DB rule: admin
 * identity lives in the admin DB, never the main game DB.
 */

export const SESSION_COOKIE_NAME = "admin_session";

export type MintedSession = {
  cookieValue: string;
  admin: {
    id: string;
    email: string;
    username: string;
    role: string;
    roles: string[];
  };
};

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

/**
 * Read one active admin from the ADMIN DB. Prefers a full `admin` so the
 * audit sees every page (page-access gating in the app keys off role +
 * allowed_pages — an admin has unrestricted access, which is what we want
 * for a layout sweep). Read-only single-row query.
 */
async function readActiveAdmin(): Promise<MintedSession["admin"]> {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error(
      "[responsive] ADMIN_DATABASE_URL is not set — cannot mint a session cookie.",
    );
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query<{
      id: string;
      email: string;
      username: string;
      role: string;
      roles: string[] | null;
    }>(
      `SELECT id, email, username, role, COALESCE(roles, ARRAY[role]) AS roles
         FROM admin_users
        WHERE is_active = TRUE
        ORDER BY (role = 'admin') DESC, created_at ASC
        LIMIT 1`,
    );
    if (res.rowCount === 0) {
      throw new Error(
        "[responsive] No is_active admin found in the ADMIN DB — cannot mint a session.",
      );
    }
    const row = res.rows[0];
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      role: row.role,
      roles: row.roles ?? [row.role],
    };
  } finally {
    await pool.end();
  }
}

/**
 * Sign an `admin_session` JWT identical to the one src/lib/session.ts#encrypt
 * produces, for the given admin identity. The payload's `expiresAt` is a
 * Date 12h in the future so `src/middleware.ts` accepts it.
 */
async function signSessionCookie(
  admin: MintedSession["admin"],
): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "[responsive] SESSION_SECRET is not set — cannot sign a session cookie.",
    );
  }
  const encodedKey = new TextEncoder().encode(secret);
  const expiresAt = new Date(Date.now() + TWELVE_HOURS_MS);

  // Payload shape MUST match SessionPayload in src/lib/session.ts. `jose`
  // serializes the Date to an ISO string inside the JWT; middleware reads
  // it back with `new Date(session.expiresAt)`.
  const payload: Record<string, unknown> = {
    userId: admin.id,
    role: admin.role,
    roles: admin.roles,
    email: admin.email,
    username: admin.username,
    expiresAt,
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(encodedKey);
}

/**
 * One-call convenience: read an active admin (read-only) + sign the cookie.
 */
async function mintAdminSession(): Promise<MintedSession> {
  const admin = await readActiveAdmin();
  const cookieValue = await signSessionCookie(admin);
  return { cookieValue, admin };
}

/**
 * Pick one real entity id to render a detail route. Layout testing does not
 * need production data — any valid row renders the same layout. Read-only.
 *
 * Returns null if the table is empty (the caller skips the detail route and
 * logs a warning rather than failing the whole sweep).
 */
async function readSampleUserId(): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[responsive] DATABASE_URL is not set — cannot pick a sample user id.",
    );
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM "user" ORDER BY created_at DESC LIMIT 1`,
    );
    return res.rowCount && res.rowCount > 0 ? res.rows[0].id : null;
  } finally {
    await pool.end();
  }
}

/** Mint a session that passes `canAccessCreatorHub`. */
export async function mintCreatorHubSession(): Promise<MintedSession> {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) {
    throw new Error(
      "[responsive] ADMIN_DATABASE_URL is not set — cannot mint Creator Hub session.",
    );
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const motha = await pool.query<{
      id: string;
      email: string;
      username: string;
      role: string;
      roles: string[] | null;
    }>(
      `SELECT id, email, username, role, COALESCE(roles, ARRAY[role]) AS roles
         FROM admin_users
        WHERE is_active = TRUE AND lower(username) = 'motha'
        LIMIT 1`,
    );
    if (motha.rowCount && motha.rowCount > 0) {
      const row = motha.rows[0];
      const admin = {
        id: row.id,
        email: row.email,
        username: row.username,
        role: row.role,
        roles: row.roles ?? [row.role],
      };
      return { cookieValue: await signSessionCookie(admin), admin };
    }

    await pool.query(
      `INSERT INTO admin_settings (key, value, updated_by, updated_at)
       VALUES ('creator_hub_access_admin_enabled', 'true', NULL, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = 'true', updated_at = NOW()`,
    );
    return mintAdminSession();
  } finally {
    await pool.end();
  }
}

/** Pick one house ad code for Hub ads detail (null → skip). Read-only. */
async function readSampleAdCode(): Promise<string | null> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const mainUrl = process.env.DATABASE_URL;
  if (!adminUrl || !mainUrl) return null;

  const adminPool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  let houseUserId: string | null = null;
  try {
    const setting = await adminPool.query<{ value: string }>(
      `SELECT value FROM admin_settings WHERE key = 'house_affiliate_user_id' LIMIT 1`,
    );
    houseUserId =
      setting.rowCount && setting.rowCount > 0 ? setting.rows[0].value : null;
  } finally {
    await adminPool.end();
  }
  if (!houseUserId) return null;

  const mainPool = new pg.Pool({ connectionString: mainUrl, max: 1 });
  try {
    const res = await mainPool.query<{ code: string }>(
      `SELECT code FROM affiliate_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [houseUserId],
    );
    return res.rowCount && res.rowCount > 0 ? res.rows[0].code : null;
  } catch {
    return null;
  } finally {
    await mainPool.end();
  }
}

/** Pick one creator-role user for Hub detail routes (null → skip). */
export async function readSampleCreatorId(): Promise<string | null> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[responsive] DATABASE_URL is not set — cannot pick a sample creator id.",
    );
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id
         FROM "user" u
         JOIN user_roles ur ON ur.user_id = u.id
        WHERE ur.role = 'creator'
        ORDER BY u.created_at DESC
        LIMIT 1`,
    );
    return res.rowCount && res.rowCount > 0 ? res.rows[0].id : null;
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}
