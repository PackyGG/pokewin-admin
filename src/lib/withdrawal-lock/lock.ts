import "server-only";

import { cache } from "react";

import { adminDb } from "@/lib/admin-db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Withdrawal-lock model (admin DB only — no MAIN write required).
 *
 * Policy (owner rule 2026-07-01): every user on the admin-managed
 * `excluded_users` blacklist is withdrawal-LOCKED BY DEFAULT. While locked,
 * NONE of the withdrawal server actions (process / cancel / ship / complete /
 * fail) may run for any of that user's withdrawals — any withdrawal type,
 * crypto or physical. The ONLY way to lift the lock is a per-user UNLOCK
 * override that the root owner (motha) grants, recorded in
 * `admin_withdrawal_unlocks`. Removing the override re-locks the user.
 *
 *   locked(user) = isExcluded(user) AND NOT hasUnlockOverride(user)
 *
 * The lock lives entirely in the admin DB (the blacklist + the override
 * table). It is enforced at the admin panel's withdrawal-action layer; it
 * never touches / requires a change to the MAIN game DB.
 *
 * Both reads fail SAFE:
 *   • the blacklist read (`getExcludedUserIds`) already fails closed
 *     (last-known-good, else throws so metrics aren't rendered unscoped);
 *   • the unlock-override read degrades to "no override" (→ the user stays
 *     LOCKED) on any admin-DB fault, including the pre-provision
 *     missing-table case. Fail-safe here means: never accidentally ALLOW a
 *     withdrawal we should have blocked.
 */

// Postgres "undefined_table" — same signals the excluded-users layer treats
// as "table missing" (P2021 typed model / P2010 raw / 42P01 SQLSTATE). Until
// prisma/admin/sql/2026-07-01_add_withdrawal_unlocks.up.sql is applied, the
// override read degrades to "no override" so excluded users stay locked.
function isTableMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  return e.code === "P2021" || e.code === "P2010" || e.meta?.code === "42P01";
}

/**
 * Set of packy.gg user_ids that currently hold a withdrawal UNLOCK override.
 * Cached per request via React `cache()`. Fail-safe: any read error (incl.
 * the missing-table pre-provision case) resolves to an EMPTY set, so a fault
 * can only ever leave excluded users LOCKED — never silently unlock one.
 */
export const getWithdrawalUnlockedUserIds = cache(
  async (): Promise<Set<string>> => {
    try {
      const rows = await adminDb.admin_withdrawal_unlocks.findMany({
        select: { target_user_id: true },
      });
      return new Set(rows.map((r) => r.target_user_id));
    } catch (err) {
      if (!isTableMissing(err)) {
        console.error(
          "[withdrawal-lock] failed to read unlock overrides — treating as none (users stay locked):",
          err,
        );
      }
      return new Set<string>();
    }
  },
);

/**
 * True if the given user's withdrawals are currently LOCKED — i.e. the user
 * is on the excluded_users blacklist AND has no motha-granted unlock override.
 * Source of truth consulted by both the server actions (enforcement) and the
 * list/detail surfaces (indication). Fail-safe on both underlying reads.
 */
export async function isWithdrawalLocked(userId: string): Promise<boolean> {
  const excluded = await getExcludedUserIds();
  if (!excluded.includes(userId)) return false;
  const unlocked = await getWithdrawalUnlockedUserIds();
  return !unlocked.has(userId);
}

/**
 * Thrown by {@link assertWithdrawalNotLocked} when a withdrawal action is
 * attempted for a locked user. Carries a stable, user-facing message; the
 * withdrawal actions surface it verbatim (it is a verified business state,
 * not a redacted crash).
 */
export const WITHDRAWAL_LOCKED_MESSAGE =
  "Withdrawals are locked for this user (excluded account). Only motha can unlock them.";

/**
 * Guard for the withdrawal server actions. Throws with a stable message when
 * the target user's withdrawals are locked, so the action can convert it into
 * a `fail(...)` ServerActionResult (or let the legacy throw-style helpers
 * toast it). Callers pass the withdrawal's owning `user_id`.
 */
export async function assertWithdrawalNotLocked(userId: string): Promise<void> {
  if (await isWithdrawalLocked(userId)) {
    throw new Error(WITHDRAWAL_LOCKED_MESSAGE);
  }
}
