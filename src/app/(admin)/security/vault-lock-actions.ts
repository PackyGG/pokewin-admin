"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { SECURITY_CACHE_TAG } from "./security-cache-tag";
import { getDb } from "@/lib/db";
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
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_upsert_vault_lock", "upsert vault lock windows");

  if (hours <= 0) throw new Error("Hours must be positive");
  if (!label.trim()) throw new Error("Label is required");

  if (id) {
    await db.vault_lock_times.update({
      where: { id },
      data: { hours, label: label.trim() },
    });
  } else {
    await db.vault_lock_times.create({
      data: { hours, label: label.trim() },
    });
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
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_vault_lock", "delete vault lock windows");

  await db.vault_lock_times.delete({ where: { id } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "vault_lock_time_deleted",
    metadata: { id },
  });

  revalidatePath("/security");
  revalidateTag(SECURITY_CACHE_TAG);
}
