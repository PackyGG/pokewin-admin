"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

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

  revalidatePath("/battles");
  revalidatePath(`/battles/${battleId}`);
}
