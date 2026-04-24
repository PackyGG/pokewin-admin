"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  DB_ENV_COOKIE,
  DB_ENVS,
  isDevDbConfigured,
  type DbEnv,
} from "@/lib/db-env";

/**
 * Switch the current admin's Main-DB target between prod and dev.
 *
 * - Admin role only (support/marketing/creator cannot see or invoke
 *   this — the UI toggle is also gated, but we enforce server-side
 *   regardless).
 * - "dev" is rejected when DEV_DATABASE_URL is not configured.
 * - Writes an audit event so we have a trail of who pointed admin
 *   writes at which environment and when.
 * - Revalidates the whole layout so any cached data from the prior
 *   env is dropped from the server render cache.
 */
export async function switchDbEnv(next: DbEnv): Promise<void> {
  const session = await requireAdmin();

  if (!DB_ENVS.includes(next)) {
    throw new Error("Invalid environment");
  }
  if (next === "dev" && !isDevDbConfigured()) {
    throw new Error("DEV environment is not configured on this server");
  }

  const jar = await cookies();
  const current = jar.get(DB_ENV_COOKIE)?.value ?? "prod";
  if (current === next) return;

  jar.set(DB_ENV_COOKIE, next, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // No `expires` — this is a session-scoped preference. It survives
    // page navigation but clears when the browser closes, which is
    // the safest default for "I'm temporarily pointed at dev".
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "db_env_switched",
    metadata: { from: current, to: next },
  });

  revalidatePath("/", "layout");
}
