"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";

import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { vault_lock_times } from "@/lib/db-schema/main/schema";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Vault-lock-time server actions — relocated verbatim from the old
 * `/settings` page into the /security feature when Vault Lock Times moved
 * under Security. The guards/capabilities are unchanged: requireAdmin +
 * the same `__can_upsert_vault_lock` / `__can_delete_vault_lock`
 * capabilities. Only `revalidatePath` now targets /security (the new home)
 * instead of the removed /settings route.
 *
 * These WRITE the MAIN/PROD game DB at runtime (operator-triggered). The
 * relocation does not change that behaviour.
 */
export async function upsertVaultLockTime(
  id: string | null,
  hours: number,
  label: string
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_upsert_vault_lock", "upsert vault lock windows");

  if (hours <= 0) throw new Error("Hours must be positive");
  if (!label.trim()) throw new Error("Label is required");

  if (id) {
    const updated = await db
      .update(vault_lock_times)
      .set({
        hours,
        label: label.trim(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(vault_lock_times.id, id))
      .returning({ id: vault_lock_times.id });
    if (!updated[0]) throw new Error("Vault lock time not found");
  } else {
    await db.insert(vault_lock_times).values({ hours, label: label.trim() });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "vault_lock_time_updated",
    metadata: { id, hours, label },
  });

  revalidatePath("/security");
  revalidateTag(SECURITY_CACHE_TAG);
}

export async function deleteVaultLockTime(id: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_vault_lock", "delete vault lock windows");

  const deleted = await db
    .delete(vault_lock_times)
    .where(eq(vault_lock_times.id, id))
    .returning({ id: vault_lock_times.id });
  if (!deleted[0]) throw new Error("Vault lock time not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "vault_lock_time_deleted",
    metadata: { id },
  });

  revalidatePath("/security");
  revalidateTag(SECURITY_CACHE_TAG);
}
