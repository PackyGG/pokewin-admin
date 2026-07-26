import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { AdminRole } from "../src/lib/admin-roles";
import { ALL_ADMIN_ROLES } from "../src/lib/admin-roles";
import { admin_roles } from "../src/lib/db-schema/admin/schema";
import { ROLE_BASELINES } from "../src/lib/role-baselines";

const SYSTEM_ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Administrator",
  support: "Support",
  marketing: "Marketing",
  creator: "Creator",
  pack_creator: "Pack Creator",
  creator_manager: "Creator Manager",
};

const SYSTEM_ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  admin:
    "Built-in superuser. Total bypass of every page / capability gate (managed in code; editing here does not change its access).",
  support:
    "Built-in support role — user management, moderation, withdrawals, and the core support pages.",
  marketing: "Built-in marketing role.",
  creator: "Built-in creator self-service role.",
  pack_creator:
    "Built-in pack-creator role — limited to creating/editing packs, cards, sets, and upgrader outputs.",
  creator_manager: "Built-in Creator Hub manager role.",
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function requiredAdminDatabaseUrl(): string {
  const value = process.env.ADMIN_DATABASE_URL?.trim();
  if (!value) {
    throw new Error("ADMIN_DATABASE_URL is required");
  }
  return value;
}

async function main(): Promise<void> {
  const connectionString = requiredAdminDatabaseUrl();
  if (
    [process.env.DATABASE_URL, process.env.DATABASE_URL_POOLED]
      .flatMap((value) => (value ? [value.trim()] : []))
      .includes(connectionString)
  ) {
    throw new Error("Refusing to seed roles: ADMIN_DATABASE_URL matches MAIN");
  }
  const pool = new Pool({
    connectionString,
    application_name: "pokewin-admin-role-seed",
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => {
    console.error("[seed-admin-rolev2] Pool error:", error.message);
  });

  const db = drizzle(pool, {
    schema: { admin_roles },
    casing: "snake_case",
  });

  try {
    const chosenNames = await db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: admin_roles.id,
          name: admin_roles.name,
          systemKey: admin_roles.system_key,
        })
        .from(admin_roles);
      const nameOwner = new Map<
        string,
        { id: string; systemKey: AdminRole | null }
      >();
      for (const role of existing) {
        nameOwner.set(normalizeName(role.name), {
          id: role.id,
          systemKey: role.systemKey,
        });
      }

      function pickName(systemKey: AdminRole, label: string): string {
        const candidates = [
          label,
          `${label} (system)`,
          `${label} (${systemKey})`,
        ];
        for (const candidate of candidates) {
          const owner = nameOwner.get(normalizeName(candidate));
          if (!owner || owner.systemKey === systemKey) {
            nameOwner.set(normalizeName(candidate), {
              id: "reserved",
              systemKey,
            });
            return candidate;
          }
        }

        const forced = `system_role_${systemKey}`;
        nameOwner.set(normalizeName(forced), {
          id: "reserved",
          systemKey,
        });
        return forced;
      }

      const names: Partial<Record<AdminRole, string>> = {};
      for (const role of ALL_ADMIN_ROLES) {
        const name = pickName(role, SYSTEM_ROLE_LABELS[role]);
        const capabilities = [...ROLE_BASELINES[role].tokens];
        const now = new Date().toISOString();

        await tx
          .insert(admin_roles)
          .values({
            name,
            system_key: role,
            description: SYSTEM_ROLE_DESCRIPTIONS[role],
            is_system: true,
            capabilities,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: admin_roles.system_key,
            set: {
              name,
              description: SYSTEM_ROLE_DESCRIPTIONS[role],
              is_system: true,
              capabilities,
              updated_at: now,
            },
          });

        names[role] = name;
        console.log(
          `[seed-admin-rolev2] upserted system_key=${role} name="${name}" capabilities=${capabilities.length}`,
        );
      }
      return names;
    });

    console.log(
      "[seed-admin-rolev2] done. Names chosen:",
      JSON.stringify(chosenNames),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
