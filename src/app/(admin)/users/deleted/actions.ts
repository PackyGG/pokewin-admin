"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { sql } from "drizzle-orm";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { adminDrizzle } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import type { DeletedUserSnapshot } from "@/lib/deleted-users/snapshot";

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  );
}

export async function restoreDeletedUser(
  snapshotId: string,
  totpCode: string,
): Promise<void> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_delete_user",
    "restore deleted users",
  );
  await require2FA(session.userId, totpCode);

  const snapshotResult = await adminDrizzle.execute<{
    id: string;
    username: string | null;
    expires_at: Date | string;
    restored_at: Date | string | null;
    snapshot: DeletedUserSnapshot;
  }>(sql`
    SELECT id, username, expires_at, restored_at, snapshot
    FROM admin_deleted_users
    WHERE id = ${snapshotId}
  `);
  const snapshotRow = snapshotResult.rows[0];
  if (!snapshotRow) throw new Error("Snapshot not found");
  if (snapshotRow.restored_at) {
    throw new Error("Snapshot has already been restored");
  }
  if (new Date(snapshotRow.expires_at).getTime() < Date.now()) {
    throw new Error("Snapshot has expired and cannot be restored");
  }

  const snapshot = snapshotRow.snapshot;
  if (!snapshot?.user) {
    throw new Error("Snapshot is malformed — cannot restore");
  }

  const db = await getPrimaryDrizzleDb();
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM "user" WHERE id = ${snapshotId} LIMIT 1
  `);
  if (existing.rows[0]) {
    throw new Error(
      "A user with this id already exists in main DB — restore aborted",
    );
  }

  const userData = cleanRow(snapshot.user);
  const balancesData = snapshot.balances ? cleanRow(snapshot.balances) : null;
  const inventoryData = snapshot.user_inventory.map(cleanRow);
  const vouchersData = snapshot.vouchers.map(cleanRow);
  const rakebackData = snapshot.rakeback_claims.map((row) => ({
    ...cleanRow(row),
    ledger_tx_id: null,
  }));
  if (balancesData) balancesData.last_transaction_id = null;

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO "user"
        SELECT (jsonb_populate_record(
          NULL::"user", ${JSON.stringify(userData)}::jsonb
        )).*
      `);
      if (balancesData) {
        await tx.execute(sql`
          INSERT INTO balances
          SELECT (jsonb_populate_record(
            NULL::balances, ${JSON.stringify(balancesData)}::jsonb
          )).*
        `);
      }
      if (inventoryData.length > 0) {
        await tx.execute(sql`
          INSERT INTO user_inventory
          SELECT restored.*
          FROM jsonb_populate_recordset(
            NULL::user_inventory, ${JSON.stringify(inventoryData)}::jsonb
          ) AS restored
          ON CONFLICT DO NOTHING
        `);
      }
      if (vouchersData.length > 0) {
        await tx.execute(sql`
          INSERT INTO vouchers
          SELECT restored.*
          FROM jsonb_populate_recordset(
            NULL::vouchers, ${JSON.stringify(vouchersData)}::jsonb
          ) AS restored
          ON CONFLICT DO NOTHING
        `);
      }
      if (rakebackData.length > 0) {
        await tx.execute(sql`
          INSERT INTO rakeback_claims
          SELECT restored.*
          FROM jsonb_populate_recordset(
            NULL::rakeback_claims, ${JSON.stringify(rakebackData)}::jsonb
          ) AS restored
          ON CONFLICT DO NOTHING
        `);
      }
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Restore failed: ${error.message}`
        : "Restore failed: unknown error",
    );
  }

  await adminDrizzle.execute(sql`
    UPDATE admin_deleted_users
    SET restored_at = NOW(), restored_by = ${session.userId}
    WHERE id = ${snapshotId} AND restored_at IS NULL
  `);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_restored",
    targetUserId: snapshotId,
    metadata: {
      snapshot_id: snapshotId,
      username: snapshotRow.username,
      inventory_restored: inventoryData.length,
      vouchers_restored: vouchersData.length,
      rakeback_restored: rakebackData.length,
    },
  });

  revalidatePath("/users");
  revalidatePath("/users/deleted");
  revalidatePath(`/users/${snapshotId}`);
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
}

export async function purgeDeletedUserSnapshot(
  snapshotId: string,
  totpCode: string,
): Promise<void> {
  const session = await requireAdmin();
  await requireCapability(
    session,
    "__can_delete_user",
    "purge user snapshots",
  );
  await require2FA(session.userId, totpCode);

  const existingResult = await adminDrizzle.execute<{
    id: string;
    username: string | null;
  }>(sql`
    SELECT id, username FROM admin_deleted_users WHERE id = ${snapshotId}
  `);
  const existing = existingResult.rows[0];
  if (!existing) throw new Error("Snapshot not found");

  await adminDrizzle.execute(sql`
    DELETE FROM admin_deleted_users WHERE id = ${snapshotId}
  `);
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_snapshot_purged",
    targetUserId: snapshotId,
    metadata: { snapshot_id: snapshotId, username: existing.username },
  });
  revalidatePath("/users/deleted");
}
