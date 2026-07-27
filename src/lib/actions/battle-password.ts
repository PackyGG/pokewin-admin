"use server";

import { eq } from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import { battles } from "@/lib/db-schema/main/schema";
import { requireRole } from "@/lib/dal";
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
 * no password set (defensive — callers only render the reveal button when
 * hasPassword=true, but the action re-validates).
 *
 * Shared across surfaces (via `BattlePasswordReveal` in
 * `src/components/battle-password-reveal.tsx`): the user-detail
 * transactions tab and transaction detail modal. Kept in
 * `src/lib/actions/` (not a page directory) because it has no standalone
 * admin page of its own — the dedicated /battles admin page was removed
 * (2026-07), but battle data and this shared reveal action are unaffected.
 */
export async function revealBattlePassword(battleId: string): Promise<string> {
  if (!isUuid(battleId)) throw new Error("Invalid battle id");

  const session = await requireRole(["admin"]);
  const db = await getReadDrizzleDb();

  const [battle] = await db
    .select({
      id: battles.id,
      user_id: battles.user_id,
      password: battles.password,
    })
    .from(battles)
    .where(eq(battles.id, battleId))
    .limit(1);

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
