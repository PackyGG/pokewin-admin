import { notFound } from "next/navigation";

import { verifySession } from "@/lib/dal";
import { EOS_TEST_USERNAMES } from "@/lib/eos-test-access-shared";
import type { SessionPayload } from "@/lib/session";

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
