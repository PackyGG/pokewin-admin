/**
 * RoleV2 (P0) seed — idempotent, run-once.
 *
 * Materializes the six built-in `admin_role` enum values as first-class
 * `is_system = true` rows in `admin_roles`, keyed by the NEW `system_key`
 * column. Each row's `capabilities` is BYTE-EQUAL to
 * `ROLE_BASELINES[enum].tokens` (src/lib/role-baselines.ts) — the parity
 * harness asserts this. All six typed limit columns are left NULL (no per-role
 * cap in this behavior-neutral foundation phase).
 *
 * NAME COLLISION HANDLING (required — do not assume):
 *   `admin_roles.name` is `@unique`, and a LIVE custom row is named
 *   "creator manager". Identity here is `system_key`, NOT `name`, so each
 *   system row gets a canonical label ("Administrator" / "Support" / …). We
 *   DETECT existing names first (normalized, case-insensitive) and, if a
 *   chosen label collides with a row that ISN'T this system row, fall back to
 *   a clearly-distinct "<label> (system)" name. The seed never renames or
 *   touches the existing custom row.
 *
 * ZERO mutation of anything else: this only adds/updates the six
 * `admin_roles` system rows. It does NOT write `admin_users.allowed_pages`,
 * `permission_grants`, `permission_revokes`, or `admin_balance_limits`.
 *
 * Run (after applying prisma/admin/sql/2026-06-14_rolev2_columns.up.sql):
 *   npm run admin:seed-rolev2
 */
import "dotenv/config";
import { PrismaClient, type admin_role } from "../../src/generated/admin-prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { ROLE_BASELINES } from "../../src/lib/role-baselines";
import { ALL_ADMIN_ROLES } from "../../src/lib/admin-roles";

// Canonical human labels for each built-in system row. Distinct from the live
// custom role "creator manager" by capitalization; the collision guard below
// still verifies and falls back if any other row already holds the label.
const SYSTEM_ROLE_LABELS: Record<admin_role, string> = {
  admin: "Administrator",
  support: "Support",
  marketing: "Marketing",
  creator: "Creator",
  pack_creator: "Pack Creator",
  creator_manager: "Creator Manager",
};

const SYSTEM_ROLE_DESCRIPTIONS: Record<admin_role, string> = {
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

/** lowercase + whitespace/hyphens → underscores (matches the custom-role normalizer). */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.ADMIN_DATABASE_URL!,
    max: 2,
    keepAlive: true,
  });
  pool.on("error", (err) => {
    console.error("[seed-rolev2] Pool error:", err.message);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const db = new PrismaClient({ adapter });

  try {
    // ── Detect existing names so we never collide with a custom row ──────────
    // Map normalized-name → the row that currently holds it (id + its
    // system_key, so we can tell "this is already MY system row" apart from
    // "a different row owns this name").
    const existing = await db.admin_roles.findMany({
      select: { id: true, name: true, system_key: true },
    });
    const nameOwner = new Map<
      string,
      { id: string; systemKey: admin_role | null }
    >();
    for (const r of existing) {
      nameOwner.set(normalizeName(r.name), {
        id: r.id,
        systemKey: r.system_key,
      });
    }

    /**
     * Choose a non-colliding `name` for the system row identified by
     * `systemKey`. Prefer the canonical label; if a DIFFERENT row already
     * owns that normalized name, fall back to "<label> (system)" — and if even
     * that collides, suffix the enum key. The row that already IS this system
     * row (matched by system_key) does not count as a collision.
     */
    function pickName(systemKey: admin_role, label: string): string {
      const candidates = [label, `${label} (system)`, `${label} (${systemKey})`];
      for (const candidate of candidates) {
        const owner = nameOwner.get(normalizeName(candidate));
        if (!owner || owner.systemKey === systemKey) {
          // Free, or already owned by THIS system row → safe to use.
          // Reserve it so two system rows can't pick the same fallback.
          nameOwner.set(normalizeName(candidate), { id: "self", systemKey });
          return candidate;
        }
      }
      // Extremely unlikely final fallback — guaranteed unique by the enum key.
      const forced = `system_role_${systemKey}`;
      nameOwner.set(normalizeName(forced), { id: "self", systemKey });
      return forced;
    }

    const chosenNames: Record<string, string> = {};

    for (const role of ALL_ADMIN_ROLES) {
      const enumKey = role as admin_role;
      const baseline = ROLE_BASELINES[role];
      const capabilities = [...baseline.tokens]; // byte-equal to code
      const label = SYSTEM_ROLE_LABELS[enumKey];
      const name = pickName(enumKey, label);
      chosenNames[enumKey] = name;

      // UPSERT keyed on the NEW unique `system_key`. On a re-run we refresh the
      // canonical capabilities + label/description but never touch limits
      // (kept NULL) and never touch any other row.
      await db.admin_roles.upsert({
        where: { system_key: enumKey },
        create: {
          name,
          system_key: enumKey,
          description: SYSTEM_ROLE_DESCRIPTIONS[enumKey],
          is_system: true,
          capabilities,
          // All six typed limit columns intentionally NULL (no per-role cap).
        },
        update: {
          name,
          description: SYSTEM_ROLE_DESCRIPTIONS[enumKey],
          is_system: true,
          capabilities,
        },
        select: { id: true },
      });

      console.log(
        `[seed-rolev2] upserted system_key=${enumKey} name="${name}" capabilities=${capabilities.length}`,
      );
    }

    console.log(
      "[seed-rolev2] done. Names chosen:",
      JSON.stringify(chosenNames),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
