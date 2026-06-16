"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { BATTLES_LIST_TAG, BATTLES_DETAIL_TAG } from "@/lib/queries/battles-cache";
import { requirePageAccess, requireRole } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isUuid } from "@/lib/utils/ids";

/**
 * Reveals the plaintext password an owner set on a private battle so an
 * admin can hand it back to a user who forgot it.
 *
 * Locked to role `admin` (not support/marketing/creator) because the value
 * is plaintext and the audit-log review surface is admin-only anyway. Every
 * successful reveal writes a `battle_password_viewed` admin_audit_events
 * row scoped to the battle owner's user_id so misuse is traceable.
 *
 * Returns the password string; throws if the battle doesn't exist or has
 * no password set (defensive — the UI only renders the reveal button when
 * getBattleDetail returns hasPassword=true, but the action re-validates).
 */
export async function revealBattlePassword(battleId: string): Promise<string> {
  if (!isUuid(battleId)) throw new Error("Invalid battle id");

  const session = await requireRole(["admin"]);
  const db = await getDb();

  const battle = await db.battles.findUnique({
    where: { id: battleId },
    select: { id: true, user_id: true, password: true },
  });

  if (!battle) throw new Error("Battle not found");
  if (!battle.password) throw new Error("This battle has no password set");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "battle_password_viewed",
    targetUserId: battle.user_id,
    metadata: { battle_id: battle.id },
  });

  return battle.password;
}

export async function cancelBattle(battleId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/battles");
  await requireCapability(session, "__can_cancel_battle", "cancel battles");

  const battle = await db.battles.findUnique({
    where: { id: battleId },
    include: {
      battle_participants: true,
    },
  });

  if (!battle) throw new Error("Battle not found");
  if (battle.status !== "waiting") {
    throw new Error("Only waiting battles can be cancelled");
  }

  const participantUserIds = battle.battle_participants
    .filter((p) => p.user_id !== null)
    .map((p) => p.user_id!);

  const betAmount = Number(battle.bet_amount);

  // Fetch current balances for ledger entries
  const balances = participantUserIds.length > 0
    ? await db.balances.findMany({
        where: { user_id: { in: participantUserIds } },
        select: { user_id: true, available_balance: true },
      })
    : [];
  const balanceMap = new Map(balances.map((b) => [b.user_id, Number(b.available_balance)]));

  await db.$transaction([
    db.battles.update({
      where: { id: battleId },
      data: { status: "cancelled" },
    }),
    // Refund participants who joined
    ...participantUserIds.map((userId) =>
      db.balances.update({
        where: { user_id: userId },
        data: {
          available_balance: { increment: betAmount },
        },
      })
    ),
    // Create refund ledger entries
    ...participantUserIds.map((userId) => {
      const before = balanceMap.get(userId);
      // If a participant's balance row is missing something went wrong
      // upstream — fail the whole cancellation rather than write a ledger
      // entry with a bogus balance_before of 0, which would corrupt the
      // immutable audit chain.
      if (before === undefined) {
        throw new Error(
          `Cannot refund battle: balance missing for participant ${userId}`
        );
      }
      return db.ledger_transactions.create({
        data: {
          id: crypto.randomUUID(),
          user_id: userId,
          type: "battle_refund",
          amount: betAmount,
          balance_before: before,
          balance_after: before + betAmount,
          description: "Battle cancelled by admin",
          status: "completed",
        },
      });
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "battle_cancelled",
    metadata: {
      battle_id: battleId,
      refunded_users: participantUserIds.length,
      refund_amount: Number(battle.bet_amount),
    },
  });

  // Bust the prod-only unstable_cache layer (path revalidation alone does
  // not invalidate tagged data-cache entries) so the cancelled status
  // shows immediately on both the list and the detail view.
  revalidateTag(BATTLES_LIST_TAG);
  revalidateTag(BATTLES_DETAIL_TAG);
  revalidatePath("/battles");
  revalidatePath(`/battles/${battleId}`);
}
