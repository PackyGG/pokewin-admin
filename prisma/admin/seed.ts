import "dotenv/config";
import { PrismaClient } from "../../src/generated/admin-prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import bcrypt from "bcryptjs";

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

  const email = "admin@packy.gg";
  const username = "admin";
  const password = process.env.ADMIN_SEED_PASSWORD || "CHANGEME";

  const existing = await db.admin_users.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin user ${email} already exists, skipping.`);
    return;
  }

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

  console.log(`Created admin user: ${email} (password: ${password})`);
  console.log("TOTP setup will happen on first login.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
