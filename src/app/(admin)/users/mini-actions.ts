"use server";

import {
  getUserPermissions,
  sessionIsAdmin,
  verifySession,
} from "@/lib/dal";
import { logError } from "@/lib/errors/logger";
import {
  fail,
  ok,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";
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
 *
 * Returns a discriminated union instead of throwing so the client never
 * sees raw Server Components / redirect digest errors in production.
 */
export async function fetchUserMiniSummary(
  userId: string,
): Promise<ServerActionResult<UserMiniSummary>> {
  try {
    const session = await verifySession();
    if (!sessionIsAdmin(session)) {
      const allowed = await getUserPermissions(session.userId);
      if (!allowed.includes("/users")) {
        return fail(
          "You don't have permission to preview user details.",
          "FORBIDDEN",
        );
      }
    }

    const trimmed = userId?.trim();
    if (!trimmed) {
      return fail("Invalid user.", "NOT_FOUND");
    }

    const data = await getUserMiniSummary(trimmed);
    if (!data) {
      return fail(
        "This user wasn't found — they may have been deleted.",
        "NOT_FOUND",
      );
    }
    return ok(data);
  } catch (err) {
    logError("users.miniSummary", "fetchUserMiniSummary failed", err);
    return fail(
      "Couldn't load this preview right now. Try again or open the full profile.",
      "LOAD_FAILED",
    );
  }
}
