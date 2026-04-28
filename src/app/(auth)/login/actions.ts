"use server";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { adminDb } from "@/lib/admin-db";
import { createSession, createPendingSession } from "@/lib/session";
import { generateSecret } from "@/lib/totp";
import { redirect } from "next/navigation";
import { getDefaultRouteForUser } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { MS_PER_MINUTE, MS_PER_HOUR } from "@/lib/utils/time";

const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export type LoginState = {
  error?: string;
  requires2FA?: boolean;
  requiresSetup?: boolean;
};

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

  if (!checkRateLimit(email)) {
    return { error: "Too many login attempts. Try again in a minute." };
  }

  // Explicit select so missing columns (e.g. `preferences` when the
  // migration hasn't been applied on prod yet) don't crash the login
  // flow. Only fields actually used below.
  const adminUser = await adminDb.admin_users.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
      password_hash: true,
      totp_enabled: true,
      totp_secret: true,
      is_active: true,
    },
  });

  if (!adminUser) {
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

  // No 2FA configured but secret exists (shouldn't happen, but handle gracefully).
  // Still log this login event so the audit trail stays complete — the
  // verify-2fa flow writes its own admin_login event, this branch must too.
  const headersList = await headers();
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headersList.get("user-agent") ?? null;

  await createSession({
    userId: adminUser.id,
    role: adminUser.role,
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
    adminDb.admin_sessions.create({
      data: {
        admin_user_id: adminUser.id,
        ip,
        user_agent: userAgent,
        auth_method: "no_2fa",
        expires_at: new Date(Date.now() + 8 * MS_PER_HOUR),
      },
    }),
  ]);

  redirect(await getDefaultRouteForUser(adminUser.id, adminUser.role));
}
