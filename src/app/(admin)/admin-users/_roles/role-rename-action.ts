"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isPostgresError } from "@/lib/postgres-errors";

// ---------------------------------------------------------------------------
// RoleV2 P3 — rename a role's DISPLAY name (built-in OR custom).
//
// ONE concept: Role. The 5 non-`admin` system rows can have their DISPLAY name
// edited cosmetically; `admin` (the one superuser role) is locked. A rename
// changes ONLY `admin_roles.name`:
//   • identity is `system_key`/enum for built-ins (verified: NO code reads
//     `admin_roles.name` as identity — it is display-only everywhere), and
//   • baselines/landing/RESERVED_NAMES keep keying off `system_key`/enum,
// so a rename needs NO re-materialization of any holder's `allowed_pages`
// (caps are unchanged → baseline unchanged). That is why this is a small
// name-only write, NOT routed through `updateBuiltInRole`'s heavy holder
// rewrite (which exists for CAPABILITY edits).
//
// `admin` is rejected (its name is locked). The name is validated like
// createRole (length/charset + reserved-name guard for CUSTOM rows; a system
// row may keep its own canonical name but can't take another role's). The
// `name @unique` constraint is surfaced as a friendly error.
// ---------------------------------------------------------------------------

// Built-in role names that a CUSTOM role may not shadow (normalized form).
const RESERVED_CUSTOM_NAMES: ReadonlySet<string> = new Set([
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
  "creator_manager",
]);

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const renameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters")
    .regex(/^[A-Za-z0-9 _-]+$/, "Only letters, digits, spaces, _ and -"),
  code: z.string().trim().min(1, "TOTP code is required"),
});

function isUniqueViolation(err: unknown): boolean {
  if (isPostgresError(err, "23505")) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("unique") || msg.includes("duplicate");
}

/**
 * Rename a role's display name. 2FA-gated, admin-only. `admin` is rejected.
 * Returns `{ ok }`; surfaces a clear error for a name collision.
 */
export async function renameRole(
  id: string,
  newName: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();

  const parsed = renameSchema.safeParse({ name: newName, code });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name } = parsed.data;

  await require2FA(session.userId, parsed.data.code);

  const existing = (await adminDrizzle.execute<{
    id: string;
    name: string;
    is_system: boolean;
    system_key: string | null;
  }>(sql`
    SELECT id::text, name, is_system, system_key
    FROM admin_roles
    WHERE id = ${id}::uuid
    LIMIT 1
  `)).rows[0];
  if (!existing) return { ok: false, error: "Role not found" };

  // `admin` (the one superuser role) name is locked.
  if (existing.system_key === "admin") {
    return { ok: false, error: "The admin role's name can't be changed." };
  }

  // A CUSTOM role may not take a built-in's reserved name. A SYSTEM row keeps
  // its own canonical name as valid (renaming `support` → "Support L1" is fine;
  // renaming it to "marketing" would also collide on the UNIQUE name index and
  // is caught below — but block the reserved-name clash explicitly for clarity).
  if (!existing.is_system && RESERVED_CUSTOM_NAMES.has(normalizeName(name))) {
    return { ok: false, error: "That name is reserved for a built-in role" };
  }
  if (
    existing.is_system &&
    normalizeName(name) !== normalizeName(existing.name) &&
    RESERVED_CUSTOM_NAMES.has(normalizeName(name))
  ) {
    return {
      ok: false,
      error: "That name belongs to another built-in role",
    };
  }

  // No-op rename → succeed without a write/audit.
  if (name === existing.name) return { ok: true };

  try {
    await adminDrizzle.execute(sql`
      UPDATE admin_roles
      SET name = ${name}, updated_at = NOW()
      WHERE id = ${id}::uuid
    `);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "A role with that name already exists" };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: existing.is_system
      ? "admin_builtin_role_updated"
      : "admin_role_updated",
    metadata: {
      role_id: id,
      ...(existing.system_key ? { system_key: existing.system_key } : {}),
      renamed_from: existing.name,
      renamed_to: name,
    },
  });

  revalidatePath("/admin-users");
  revalidatePath(`/admin-users/roles/${id}`);
  revalidatePath("/", "layout");
  return { ok: true };
}
