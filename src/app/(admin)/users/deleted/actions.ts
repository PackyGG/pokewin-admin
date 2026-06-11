"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import type { DeletedUserSnapshot } from "@/lib/deleted-users/snapshot";
import type { Prisma } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Helpers: re-hydrate JSON-serialized snapshot rows into the shape Prisma
// expects on the way back in. Decimal columns are persisted in the snapshot
// as canonical decimal strings (see snapshot.ts); we hand those back to
// Prisma which accepts string | number | Decimal for @db.Decimal columns.
// Date columns are persisted as ISO strings; Prisma accepts those for
// @db.Timestamp / @db.Date columns.
// ---------------------------------------------------------------------------

/**
 * Best-effort shallow clone of a snapshot row that strips Prisma's
 * internal getters / setters and leaves us with a plain JSON object the
 * generated client will accept. The snapshot is already pure JSON
 * (loaded from JSONB) so this is mostly defensive.
 */
function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// restoreDeletedUser
// ---------------------------------------------------------------------------

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

  const snapshotRow = await adminDb.admin_deleted_users.findUnique({
    where: { id: snapshotId },
  });
  if (!snapshotRow) {
    throw new Error("Snapshot not found");
  }
  if (snapshotRow.restored_at) {
    throw new Error("Snapshot has already been restored");
  }
  if (snapshotRow.expires_at.getTime() < Date.now()) {
    throw new Error("Snapshot has expired and cannot be restored");
  }

  const snapshot = snapshotRow.snapshot as unknown as DeletedUserSnapshot;
  if (!snapshot || !snapshot.user) {
    throw new Error("Snapshot is malformed — cannot restore");
  }

  const db = await getDb();

  // Refuse to restore if the user id is now in use again (race: someone
  // re-signed up while the snapshot was sitting in the bin). We don't
  // want to clobber a fresh account by re-inserting an old one with
  // the same id.
  const existing = await db.user.findUnique({
    where: { id: snapshotId },
    select: { id: true },
  });
  if (existing) {
    throw new Error(
      "A user with this id already exists in main DB — restore aborted",
    );
  }

  const userData = cleanRow(snapshot.user);
  const balancesData = snapshot.balances
    ? cleanRow(snapshot.balances)
    : null;
  const inventoryData = snapshot.user_inventory.map(cleanRow);
  const vouchersData = snapshot.vouchers.map(cleanRow);
  const rakebackData = snapshot.rakeback_claims.map(cleanRow);

  // Restore in a single transaction so a sub-insert failure (e.g.
  // duplicate inventory row, FK to a missing card) rolls everything
  // back. The user row is inserted first so balances/inventory FKs
  // resolve to the live row. We use the *Unchecked* create-input
  // variants throughout — they take plain scalar columns (no nested
  // relation writes), which matches the snapshot shape exactly.
  try {
    await db.$transaction(async (tx) => {
      await tx.user.create({
        data: userData as unknown as Prisma.UserUncheckedCreateInput,
      });
      if (balancesData) {
        // `last_transaction_id` may point at a ledger row we're NOT
        // restoring (game_sessions / ledger_transactions are
        // skipped — see end-of-block notes). Strip it so the FK
        // doesn't break; the user can claim a new ledger event next
        // time they transact and the field repopulates.
        const balancesForInsert = { ...balancesData };
        balancesForInsert.last_transaction_id = null;
        await tx.balances.create({
          data: balancesForInsert as unknown as Prisma.balancesUncheckedCreateInput,
        });
      }
      if (inventoryData.length > 0) {
        await tx.user_inventory.createMany({
          data: inventoryData as unknown as Prisma.user_inventoryCreateManyInput[],
          skipDuplicates: true,
        });
      }
      if (vouchersData.length > 0) {
        await tx.vouchers.createMany({
          data: vouchersData as unknown as Prisma.vouchersCreateManyInput[],
          skipDuplicates: true,
        });
      }
      if (rakebackData.length > 0) {
        // Same FK concern as balances — ledger_tx_id may reference a
        // ledger row we deliberately skipped. Null it out; the historic
        // payout still appears in the user's rakeback history.
        const sanitized = rakebackData.map((row) => {
          const copy = { ...row };
          copy.ledger_tx_id = null;
          return copy;
        });
        await tx.rakeback_claims.createMany({
          data: sanitized as unknown as Prisma.rakeback_claimsCreateManyInput[],
          skipDuplicates: true,
        });
      }
      // game_sessions and ledger_transactions are intentionally NOT
      // restored — their FKs (deposit_addresses, gift_cards, race
      // claims, battle participants) cascaded with the user delete and
      // can't be brought back without restoring those too. The snapshot
      // still preserves them as JSON for human review on /users/deleted.
    });
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Restore failed: ${err.message}`
        : "Restore failed: unknown error",
    );
  }

  // Mark the snapshot as restored so it can't be re-applied. We keep
  // the row visible on /users/deleted until natural expiry so an admin
  // can see the restore status.
  await adminDb.admin_deleted_users.update({
    where: { id: snapshotId },
    data: {
      restored_at: new Date(),
      restored_by: session.userId,
    },
  });

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
  // revalidatePath does NOT drop unstable_cache entries — flush the
  // /users list + KPI caches so the restored user reappears immediately.
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
}

// ---------------------------------------------------------------------------
// purgeDeletedUserSnapshot — admin-triggered immediate purge (before the
// 7-day expiry). Same capability as delete since it's the same destructive
// intent: "this user's recoverable data goes away now".
// ---------------------------------------------------------------------------

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

  const existing = await adminDb.admin_deleted_users.findUnique({
    where: { id: snapshotId },
    select: { id: true, username: true },
  });
  if (!existing) {
    throw new Error("Snapshot not found");
  }

  await adminDb.admin_deleted_users.delete({ where: { id: snapshotId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_snapshot_purged",
    targetUserId: snapshotId,
    metadata: {
      snapshot_id: snapshotId,
      username: existing.username,
    },
  });

  revalidatePath("/users/deleted");
}
