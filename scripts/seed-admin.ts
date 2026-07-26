import "dotenv/config";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  admin_roles,
  admin_users,
} from "../src/lib/db-schema/admin/schema";

const ADMIN_EMAIL = "admin@packy.gg";
const ADMIN_USERNAME = "admin";

function requiredEnv(name: "ADMIN_DATABASE_URL" | "ADMIN_SEED_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  // Refuse before opening a database connection or deriving a known default.
  const password = requiredEnv("ADMIN_SEED_PASSWORD");
  const connectionString = requiredEnv("ADMIN_DATABASE_URL").trim();
  if (
    [process.env.DATABASE_URL, process.env.DATABASE_URL_POOLED]
      .flatMap((value) => (value ? [value.trim()] : []))
      .includes(connectionString)
  ) {
    throw new Error("Refusing to seed: ADMIN_DATABASE_URL matches MAIN");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const pool = new Pool({
    connectionString,
    application_name: "pokewin-admin-seed",
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => {
    console.error("[seed-admin] Pool error:", error.message);
  });

  const db = drizzle(pool, {
    schema: { admin_roles, admin_users },
    casing: "snake_case",
  });

  try {
    const created = await db.transaction(async (tx) => {
      const [systemAdminRole] = await tx
        .select({ id: admin_roles.id })
        .from(admin_roles)
        .where(eq(admin_roles.system_key, "admin"))
        .limit(1);

      return tx
        .insert(admin_users)
        .values({
          email: ADMIN_EMAIL,
          username: ADMIN_USERNAME,
          password_hash: passwordHash,
          role: "admin",
          roles: ["admin"],
          role_id: systemAdminRole?.id,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .onConflictDoNothing({ target: admin_users.email })
        .returning({ id: admin_users.id });
    });

    if (created.length === 0) {
      console.log(`Admin user ${ADMIN_EMAIL} already exists; no changes made.`);
      return;
    }

    console.log(`Created admin user: ${ADMIN_EMAIL}`);
    console.log(
      "Password was read from ADMIN_SEED_PASSWORD and was not logged.",
    );
    console.log("TOTP setup will happen on first login.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
