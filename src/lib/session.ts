import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { MS_PER_HOUR } from "@/lib/utils/time";

const secretKey = process.env.SESSION_SECRET!;
const encodedKey = new TextEncoder().encode(secretKey);
const COOKIE_NAME = "admin_session";
const PENDING_COOKIE_NAME = "admin_2fa_pending";
const WEBAUTHN_CHALLENGE_COOKIE = "admin_webauthn_challenge";

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
  // OWNER / ULTRA-ADMIN flag. Like `roles`, this is NOT a trusted JWT claim:
  // `verifySession` re-reads `admin_users.is_owner` from the DB on every request
  // and overwrites it, so a stale cookie can't grant (or strip) owner power. The
  // permanent ROOT owner `motha` is owner via a username bypass (see
  // src/lib/owners.ts) regardless of this field. Optional because cookies minted
  // before the owner tier shipped won't carry it — consumers treat a missing
  // value as `false` (fail-closed; the DB re-read is authoritative anyway).
  isOwner?: boolean;
  expiresAt: Date;
  // JWT issued-at (seconds since epoch), populated by jose's `setIssuedAt()`
  // on mint and read back from the verified token. Drives the Phase D session-
  // revocation guard in `verifySession`: a token whose `iat` is before the
  // account's `sessions_valid_after` watermark is treated as revoked. Optional
  // because cookies minted before this field was surfaced won't carry it on the
  // typed payload — consumers treat a missing `iat` as "issued at the epoch"
  // (the safe direction: a watermark then forces a fresh login).
  iat?: number;
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

// --- WebAuthn (passkey) challenge (5-min expiry) ---
//
// A passkey ceremony is two round-trips: the server issues a random challenge,
// the authenticator signs it, and the server verifies the signature against the
// SAME challenge. We stash that challenge in a short-lived signed cookie (the
// exact pattern the pending-2FA cookie uses) so it survives the round-trip
// without any new infra. `type` pins the cookie to its ceremony (register vs
// auth) and `adminUserId` scopes it to the acting account so a register
// challenge can't be replayed into an auth flow or across users.

type WebauthnChallengePayload = {
  challenge: string;
  // "register" = profile passkey enrollment; "auth" = passkey at the login 2FA
  // step; "stepup" = passkey satisfying an in-app action gate (require2FA).
  // Pinning the ceremony keeps a challenge from one flow being replayed into
  // another (e.g. a login-time "auth" challenge can't clear a money-action gate).
  type: "register" | "auth" | "stepup";
  adminUserId: string;
  expiresAt: string;
};

export async function createWebauthnChallenge(
  payload: Omit<WebauthnChallengePayload, "expiresAt">,
) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const token = await encryptGeneric(
    { ...payload, expiresAt: expiresAt.toISOString() },
    "5m",
  );
  const cookieStore = await cookies();
  cookieStore.set(WEBAUTHN_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

export async function getWebauthnChallenge(): Promise<WebauthnChallengePayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEBAUTHN_CHALLENGE_COOKIE)?.value;
  if (!token) return null;
  return decryptGeneric<WebauthnChallengePayload>(token);
}

export async function deleteWebauthnChallenge() {
  const cookieStore = await cookies();
  cookieStore.delete(WEBAUTHN_CHALLENGE_COOKIE);
}

// --- Step-up proof token (passkey → action gate) ---
//
// A passkey can satisfy the same in-app 2FA gate a TOTP code does (require2FA).
// The ceremony (assert a registered passkey) happens in its own server action;
// on success it mints THIS short-lived signed token, which the client then
// passes to the privileged action exactly where it would have passed the
// 6-digit code. `require2FA` accepts either: a real step-up token clears the
// gate, anything else falls through to TOTP verification.
//
// The token is a bearer proof scoped to ONE admin (`adminUserId`) and pinned by
// `purpose` so a pending-login or challenge token (same signing key) can never
// be replayed as a step-up. TTL is deliberately short — a couple of minutes,
// matching the practical replay window of a typed TOTP code (neither is bound
// to a single action), so this is security-parity with the existing gate, not a
// weakening of it. Stateless by design (no DB/cookie state) so it behaves
// identically across serverless instances.

const STEP_UP_PURPOSE = "admin_stepup";
// Kept in sync with the JWT expiry string passed to encryptGeneric below.
const STEP_UP_TOKEN_TTL = "2m";

type StepUpTokenPayload = {
  purpose: typeof STEP_UP_PURPOSE;
  adminUserId: string;
};

/** Mint a step-up proof token for `adminUserId`. Caller must have already
 * verified a passkey assertion for that same admin. */
export async function createStepUpToken(adminUserId: string): Promise<string> {
  return encryptGeneric(
    { purpose: STEP_UP_PURPOSE, adminUserId },
    STEP_UP_TOKEN_TTL,
  );
}

/** True iff `token` is a currently-valid step-up proof for `adminUserId`.
 * Returns false on a missing/expired/tampered token, a wrong purpose, or a
 * token minted for a different admin — never throws, so callers can treat a
 * non-token string (e.g. a 6-digit TOTP code) as simply "not a proof". */
export async function verifyStepUpToken(
  token: string,
  adminUserId: string,
): Promise<boolean> {
  const payload = await decryptGeneric<StepUpTokenPayload>(token);
  return (
    !!payload &&
    payload.purpose === STEP_UP_PURPOSE &&
    payload.adminUserId === adminUserId
  );
}

