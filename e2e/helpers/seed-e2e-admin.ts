import "dotenv/config";
import bcrypt from "bcryptjs";
import pg from "pg";
import { Secret } from "otpauth";

/**
 * Idempotently seed a dedicated E2E admin account so tests don't touch
 * the root `admin@packy.gg` account from prisma/admin/seed.ts.
 *
 * The account is:
 *   - email:    E2E_ADMIN_EMAIL      (default: e2e-admin@test.local)
 *   - username: E2E_ADMIN_USERNAME   (default: e2e_admin)
 *   - password: E2E_ADMIN_PASSWORD   (default: E2EAdmin!Pass123)
 *   - totp:     E2E_ADMIN_TOTP_SECRET (default: generated + printed once)
 *
 * The generated TOTP secret is echoed to stdout on first run so it can
 * be pinned into `.env.local` or the CI secret store. Subsequent runs
 * require that secret to be provided — we never rotate it unless asked.
 *
 * Usage:
 *   npm run test:e2e:seed
 */

const DEFAULT_EMAIL = "e2e-admin@test.local";
const DEFAULT_USERNAME = "e2e_admin";
const DEFAULT_PASSWORD = "E2EAdmin!Pass123";

async function main() {
  const dbUrl = process.env.ADMIN_DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "[e2e:seed] ADMIN_DATABASE_URL is not set — add it to your .env.local",
    );
    process.exit(1);
  }

  const email = process.env.E2E_ADMIN_EMAIL ?? DEFAULT_EMAIL;
  const username = process.env.E2E_ADMIN_USERNAME ?? DEFAULT_USERNAME;
  const password = process.env.E2E_ADMIN_PASSWORD ?? DEFAULT_PASSWORD;

  // Use the env-provided secret if set; otherwise generate a fresh one and
  // print it. The next run MUST pass the same secret via env or the TOTP
  // codes we compute in tests will diverge from the one stored in the DB.
  let totpSecret = process.env.E2E_ADMIN_TOTP_SECRET;
  const generatedNew = !totpSecret;
  if (!totpSecret) {
    totpSecret = new Secret({ size: 20 }).base32;
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO admin_users
          (email, username, password_hash, role, is_active,
           totp_secret, totp_enabled, recovery_codes)
       VALUES ($1, $2, $3, 'admin', TRUE, $4, TRUE, ARRAY[]::text[])
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role          = 'admin',
             is_active     = TRUE,
             totp_secret   = EXCLUDED.totp_secret,
             totp_enabled  = TRUE,
             updated_at    = NOW()`,
      [email, username, passwordHash, totpSecret],
    );

    console.log(`[e2e:seed] ✓ admin ready: ${email} (role=admin, 2FA enabled)`);
    if (generatedNew) {
      console.log("");
      console.log(
        "[e2e:seed] A new TOTP secret was generated. Add this to .env.local",
      );
      console.log("[e2e:seed] so future seeds + test runs agree on the key:");
      console.log("");
      console.log(`    E2E_ADMIN_TOTP_SECRET=${totpSecret}`);
      console.log("");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[e2e:seed] failed:", err);
  process.exit(1);
});
