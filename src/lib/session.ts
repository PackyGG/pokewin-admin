import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { MS_PER_HOUR } from "@/lib/utils/time";

const secretKey = process.env.SESSION_SECRET!;
const encodedKey = new TextEncoder().encode(secretKey);
const COOKIE_NAME = "admin_session";
const PENDING_COOKIE_NAME = "admin_2fa_pending";

export type SessionPayload = {
  userId: string;
  // Primary / canonical role (highest-privilege member of `roles`).
  // Retained for the many call sites that read a singular role.
  role: string;
  // Full effective role set. Always includes `role`. Cookies signed
  // before multi-role shipped won't carry this field — `verifySession`
  // re-derives it from the DB on every request, so this stored value is
  // only a hint; consumers treat a missing/empty `roles` as `[role]`.
  roles?: string[];
  email: string;
  username: string;
  expiresAt: Date;
};

type PendingSessionPayload = {
  adminUserId: string;
  email: string;
  username: string;
  role: string;
  // Present only on the first-time-setup path (admin_users.totp_secret
  // is still NULL). Carried inside the signed pending cookie so the
  // /setup-2fa page and confirmSetup action can read it without needing
  // a separate cookie — avoiding a Server Component cookie-write that
  // Next.js 15 rejects.
  totpSecret?: string;
  expiresAt: Date;
};

export async function encrypt(payload: SessionPayload) {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(encodedKey);
}

export async function decrypt(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, encodedKey, {
      algorithms: ["HS256"],
    });
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

async function encryptGeneric(payload: Record<string, unknown>, expiry: string) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(encodedKey);
}

async function decryptGeneric<T>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, encodedKey, {
      algorithms: ["HS256"],
    });
    return payload as unknown as T;
  } catch {
    return null;
  }
}

export async function createSession(payload: Omit<SessionPayload, "expiresAt">) {
  // 12h session — keeps admins from re-logging in mid-shift. JWT
  // expiration above must match this number ("12h"). No rolling
  // refresh; the clock starts at login.
  const expiresAt = new Date(Date.now() + 12 * MS_PER_HOUR);
  const session = await encrypt({ ...payload, expiresAt });
  const cookieStore = await cookies();

  cookieStore.set(COOKIE_NAME, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return decrypt(token);
}

export async function deleteSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

// --- Pending 2FA session (5-min expiry) ---

export async function createPendingSession(payload: Omit<PendingSessionPayload, "expiresAt">) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const token = await encryptGeneric({ ...payload, expiresAt: expiresAt.toISOString() }, "5m");
  const cookieStore = await cookies();

  cookieStore.set(PENDING_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function getPendingSession(): Promise<PendingSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(PENDING_COOKIE_NAME)?.value;
  if (!token) return null;
  return decryptGeneric<PendingSessionPayload>(token);
}

export async function deletePendingSession() {
  const cookieStore = await cookies();
  cookieStore.delete(PENDING_COOKIE_NAME);
}

