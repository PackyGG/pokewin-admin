import "dotenv/config";
import { PrismaClient } from "../../src/generated/admin-prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";
import {
  SYSTEM_ROLE_CAPABILITIES,
  SYSTEM_ROLES,
} from "../../src/lib/permissions";

// Raw-SQL helper used to seed admin_roles before the generated Prisma
// client may know about the table. After `npm run admin:migrate` +
// `prisma generate` we could swap this to db.admin_roles.upsert, but
// keeping it raw makes the seed robust against partial generation.
async function upsertSystemRoles(pool: pg.Pool) {
  for (const role of SYSTEM_ROLES) {
    const caps = SYSTEM_ROLE_CAPABILITIES[role.name];
    await pool.query(
      `INSERT INTO admin_roles (name, description, is_system, capabilities)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (name) DO UPDATE
         SET capabilities = EXCLUDED.capabilities,
             description  = EXCLUDED.description,
             is_system    = TRUE,
             updated_at   = NOW()`,
      [role.name, role.description, [...caps]],
    );
    console.log(`  - system role "${role.name}" (${caps.length} caps)`);
  }
}

// Back-fill admin_users.role_id so existing users immediately start using
// the new custom-roles system (matching the hardcoded role they already
// have). Safe: only updates rows where role_id IS NULL.
async function linkExistingUsersToSystemRoles(pool: pg.Pool) {
  for (const role of SYSTEM_ROLES) {
    const res = await pool.query(
      `UPDATE admin_users u
          SET role_id = r.id
         FROM admin_roles r
        WHERE u.role_id IS NULL
          AND r.name = $1
          AND u.role::text = $1`,
      [role.name],
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`  - linked ${res.rowCount} user(s) -> "${role.name}"`);
    }
  }
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.ADMIN_DATABASE_URL!,
    max: 2,
    keepAlive: true,
  });
  pool.on("error", (err) => {
    console.error("[seed] Pool error:", err.message);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const db = new PrismaClient({ adapter });

  // 1. Ensure root admin user
  const email = "admin@packy.gg";
  const username = "admin";
  const password = process.env.ADMIN_SEED_PASSWORD || "CHANGEME";

  const existing = await db.admin_users.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 12);
    await db.admin_users.create({
      data: {
        email,
        username,
        password_hash: passwordHash,
        role: "admin",
        is_active: true,
      },
    });
    console.log(`Created admin user: ${email}`);
    console.log(
      "Password was read from ADMIN_SEED_PASSWORD env var (not logged for safety).",
    );
    console.log("TOTP setup will happen on first login.");
  } else {
    console.log(`Admin user ${email} already exists, skipping user create.`);
  }

  // 2. Seed system roles + back-fill links. Requires the admin_roles table
  //    from the latest migration. If the migration hasn't run yet, the
  //    block reports a hint and returns successfully.
  try {
    console.log("Seeding system roles:");
    await upsertSystemRoles(pool);
    console.log("Linking existing users to system roles:");
    await linkExistingUsersToSystemRoles(pool);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("admin_roles") || msg.includes("role_id")) {
      console.warn(
        "[seed] admin_roles / role_id not found - run `npm run admin:migrate` first, then re-run seed.",
      );
    } else {
      throw err;
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
