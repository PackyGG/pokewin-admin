import { notFound } from "next/navigation";

import { verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

export const EOS_TEST_USERNAMES = ["motha", "hifoen", "zog"] as const;

export function canAccessEosTest(
  session: Pick<SessionPayload, "username">,
): boolean {
  const username = (session.username ?? "").trim().toLowerCase();
  return EOS_TEST_USERNAMES.includes(
    username as (typeof EOS_TEST_USERNAMES)[number],
  );
}

export async function requireEosTestAccess(): Promise<SessionPayload> {
  const session = await verifySession();
  if (!canAccessEosTest(session)) notFound();
  return session;
}
