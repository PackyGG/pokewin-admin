"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getUserMiniSummary,
  type UserMiniSummary,
} from "@/lib/queries/users-mini";

/**
 * Server-action wrapper around `getUserMiniSummary` for the mini user
 * pop-up dialog that opens from the LiveMoneyChat rail (and any other
 * surface that wants a compact user preview). Gated on /users page
 * access — admins who can see the dashboard live feed but NOT the
 * users list shouldn't be able to peek user details via this side
 * channel.
 */
export async function fetchUserMiniSummary(
  userId: string,
): Promise<UserMiniSummary | null> {
  await requirePageAccess("/users");
  return getUserMiniSummary(userId);
}
