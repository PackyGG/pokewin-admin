"use server";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { createSession, createPendingSession, SESSION_TTL_MS } from "@/lib/session";
import { rateLimit, buildCacheKey } from "@/lib/cache/redis";
import { generateSecret } from "@/lib/totp";
import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { getEffectiveRoles, pickPrimaryRole } from "@/lib/admin-roles";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { isMandatory2faEnabled } from "@/lib/admin-guards";
import { MS_PER_MINUTE } from "@/lib/utils/time";

const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export type LoginState = {
  error?: string;
  requires2FA?: boolean;
  requiresSetup?: boolean;
};

// Fleet-wide brute-force ceilings (SECURITY_AUDIT.md MEDIUM-6). Enforced via the
// shared Upstash limiter IN ADDITION to the per-instance map below; both fail
// OPEN when Upstash isn't configured, so local / KV-less deploys behave exactly
// as before.
const LOGIN_IP_MAX_PER_MIN = 20;
const LOGIN_EMAIL_MAX_PER_MIN = 10;

// Constant, valid bcrypt hash (of a random throwaway string) used ONLY to
// equalize timing when no admin_users row matches the email: the missing-user
// path burns the same bcrypt.compare cost as the real path, so response time
// stops being an email-enumeration oracle. The compare result is always
// discarded — this hash never grants anything.
const DUMMY_PASSWORD_HASH =
  "$2b$10$Z1A7WZ90oxm1ZrdQodlN2ugIKVKa/skxzhBjL9XYRqL0Asg32HbNW";

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + MS_PER_MINUTE });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const raw = {
    email: formData.get("email"),
    password: formData.get("password"),
  };

  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const { email, password } = parsed.data;

  // Lowercased to match the fleet limiter's key below — otherwise case
  // variations of the same address sidestep the per-instance 5/min cap.
  if (!checkRateLimit(email.toLowerCase())) {
    return { error: "Too many login attempts. Try again in a minute." };
  }

  // Fleet-wide limits (SECURITY_AUDIT.md MEDIUM-6): the in-memory map above is
  // per-instance and resets on cold start, so it can't bound a distributed
  // attack. Per-IP bounds a password-spray from one source across many emails;
  // per-email bounds targeting one account across sources. Both fail OPEN when
  // Upstash is dormant (no KV env) → no behavior change without Upstash.
  const loginHeaders = await headers();
  const loginIp =
    loginHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const [ipLimit, emailLimit] = await Promise.all([
    rateLimit(buildCacheKey("ratelimit:login-ip", [loginIp]), LOGIN_IP_MAX_PER_MIN, 60),
    rateLimit(
      buildCacheKey("ratelimit:login-email", [email.toLowerCase()]),
      LOGIN_EMAIL_MAX_PER_MIN,
      60,
    ),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    return { error: "Too many login attempts. Please wait a minute and try again." };
  }

  // Explicit select so missing columns (e.g. `preferences` when the
  // migration hasn't been applied on prod yet) don't crash the login
  // flow. Only fields actually used below. The additive `roles` column is
  // read resiliently — if its migration hasn't run, the read degrades to
  // `roles: []` (→ effective `[role]`) so admins can still log in.
  const adminUser = (await adminDrizzle.execute<{
    id: string; email: string; username: string; role: string; roles: string[];
    password_hash: string; totp_enabled: boolean; totp_secret: string | null;
    is_active: boolean;
  }>(sql`
    SELECT id::text, email, username, role::text AS role,
           roles::text[] AS roles, password_hash, totp_enabled,
           totp_secret, is_active
    FROM admin_users
    WHERE email = ${email}
    LIMIT 1
  `)).rows[0];

  if (!adminUser) {
    // Timing equalizer (email-enumeration hardening): burn the same bcrypt
    // cost as the real path before returning the identical generic error.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return { error: "Invalid email or password" };
  }

  const valid = await bcrypt.compare(password, adminUser.password_hash);
  if (!valid) {
    return { error: "Invalid email or password" };
  }

  if (!adminUser.is_active) {
    return { error: "Account is deactivated." };
  }

  // If TOTP is enabled, require verification
  if (adminUser.totp_enabled) {
    await createPendingSession({
      adminUserId: adminUser.id,
      email: adminUser.email,
      username: adminUser.username,
      role: adminUser.role,
    });
    return { requires2FA: true };
  }

  // If TOTP is not set up yet, require setup. The freshly generated
  // secret is embedded in the signed pending-session cookie (not a
  // separate cookie), because Next.js 15 forbids cookie writes from a
  // Server Component render — this keeps everything in one cookie set
  // from a Server Action.
  if (!adminUser.totp_secret) {
    await createPendingSession({
      adminUserId: adminUser.id,
      email: adminUser.email,
      username: adminUser.username,
      role: adminUser.role,
      totpSecret: generateSecret(),
    });
    return { requiresSetup: true };
  }

  // A secret exists but 2FA is NOT enabled (setup was started but never
  // completed). Guard 4 — mandatory 2FA: when the flag is ON (default), this
  // password-only bypass is CLOSED — the user must finish enrollment before
  // they get a session. They already have a `totp_secret`, but `totp_enabled`
  // is false, so route them through the SETUP flow with a fresh secret (the
  // existing requiresSetup path mints a pending cookie that the (auth)
  // middleware allows — no loop). When the flag is OFF the legacy bypass below
  // still runs, so disabling the flag instantly restores the old behavior with
  // no deploy.
  if (await isMandatory2faEnabled()) {
    await createPendingSession({
      adminUserId: adminUser.id,
      email: adminUser.email,
      username: adminUser.username,
      role: adminUser.role,
      totpSecret: generateSecret(),
    });
    return { requiresSetup: true };
  }

  // No 2FA configured but secret exists (shouldn't happen, but handle gracefully).
  // Still log this login event so the audit trail stays complete — the
  // verify-2fa flow writes its own admin_login event, this branch must too.
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headersList.get("user-agent") ?? null;

  // Effective role set — `roles` when populated, else the legacy `[role]`.
  // The cookie carries it as a hint; verifySession re-reads from the DB on
  // every request so a role change mid-session takes effect immediately.
  const effectiveRoles = getEffectiveRoles(adminUser.role, adminUser.roles);
  await createSession({
    userId: adminUser.id,
    role: pickPrimaryRole(effectiveRoles),
    roles: effectiveRoles,
    email: adminUser.email,
    username: adminUser.username,
  });

  await Promise.all([
    createAdminAuditEvent({
      adminUserId: adminUser.id,
      eventType: "admin_login",
      ip,
      metadata: { method: "no_2fa" },
    }),
    adminDrizzle.execute(sql`
      INSERT INTO admin_sessions (
        admin_user_id, ip, user_agent, auth_method, expires_at
      ) VALUES (
        ${adminUser.id}::uuid, ${ip}, ${userAgent}, 'no_2fa',
        ${new Date(Date.now() + SESSION_TTL_MS)}
      )
    `),
  ]);

  redirect(await getDefaultRouteForUser(adminUser.id, adminUser.role));
}
