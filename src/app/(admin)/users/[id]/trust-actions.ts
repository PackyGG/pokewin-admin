"use server";

/**
 * Server action backing the "Refresh" button on the Trust tab.
 * Invalidates the in-process cache entry for the user and revalidates
 * the detail page so the next render recomputes from scratch.
 *
 * Read-only on the database — only clears a memoized result.
 */

import { revalidatePath } from "next/cache";
import { requirePageAccess } from "@/lib/dal";
import { invalidateRiskScore } from "@/lib/fraud/score";

export async function refreshRiskScoreAction(userId: string): Promise<void> {
  // Same access gate as the /users pages. If a role cannot see /users
  // it cannot trigger a refresh — redirect() will fire via requirePageAccess.
  await requirePageAccess("/users");
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Missing userId");
  }
  invalidateRiskScore(userId);
  revalidatePath(`/users/${userId}`);
}
