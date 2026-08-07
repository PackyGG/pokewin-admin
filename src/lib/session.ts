import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { MS_PER_HOUR } from "@/lib/utils/time";
import { PASSKEY_GRACE_TTL_MS } from "@/lib/passkey-grace-shared";

// SECURITY (SECURITY_AUDIT.md LOW): fail fast instead of the bare `!`. An
// unset SESSION_SECRET would otherwise sign/verify every admin JWT, pending-2FA
// cookie, WebAuthn challenge and step-up token with an empty key — a forgeable
// session. Throwing at module load surfaces the misconfig immediately (the app
// with a set secret is unaffected); a short secret is warned, not blocked, so a
// currently-working deployment can't be bricked by this check.
const secretKey = process.env.SESSION_SECRET;
if (!secretKey) {
  throw new Error(
    "SESSION_SECRET is not set — refusing to sign tokens with an empty key.",
  );
}
if (secretKey.length < 32) {
  console.warn(
    "[session] SESSION_SECRET is shorter than 32 characters — use a 32+ char random secret.",
  );
}
const encodedKey = new TextEncoder().encode(secretKey);

/**
 * Single source of truth for the admin session lifetime. The JWT expiry, the
 * `admin_session` cookie expiry AND the `admin_sessions` DB rows written by
 * the four login flows (password-only, TOTP/recovery, passkey, first-time 2FA
 * setup) all derive from this constant. Keeping one number prevents the drift
 * that previously had DB rows expiring at 8h while the JWT lived 12h — which
 * made the sessions list show "expired" for a token's last 4 hours and let
 * force-expire skip stamping still-live sessions.
 */
export const SESSION_TTL_MS = 12 * MS_PER_HOUR;

const COOKIE_NAME = "admin_session";
const PENDING_COOKIE_NAME = "admin_2fa_pending";
const WEBAUTHN_CHALLENGE_COOKIE = "admin_webauthn_challenge";
const PASSKEY_GRACE_COOKIE = "admin_passkey_grace";

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

async function encrypt(payload: SessionPayload) {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    // Derived from SESSION_TTL_MS so the JWT `exp` can never drift from the
    // cookie / DB-row lifetime.
    .setExpirationTime(new Date(Date.now() + SESSION_TTL_MS))
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

/**
 * Optional cookie domain, for running the dashboard across MORE THAN ONE
 * hostname (the Antifraud workspace is additionally served from
 * `fraud.packydash.com`). Setting `SESSION_COOKIE_DOMAIN=.packydash.com` makes
 * one login valid on the apex AND every sub-domain, so switching into the
 * antifraud app doesn't ask for credentials again.
 *
 * UNSET IS THE DEFAULT AND CHANGES NOTHING: without it the cookie stays
 * host-only, exactly as before. Only widen this to a domain you own entirely —
 * a parent domain shares the cookie with every sibling host under it.
 */
function sessionCookieDomain(): string | undefined {
  const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  return domain ? domain : undefined;
}

export async function createSession(payload: Omit<SessionPayload, "expiresAt">) {
  // 12h session (SESSION_TTL_MS) — keeps admins from re-logging in mid-shift.
  // No rolling refresh; the clock starts at login.
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await encrypt({ ...payload, expiresAt });
  const cookieStore = await cookies();

  cookieStore.set(COOKIE_NAME, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
    domain: sessionCookieDomain(),
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
  // A cookie written with an explicit domain is a DIFFERENT cookie from the
  // host-only one, and `delete(name)` only clears the host-only variant — so a
  // logout on a multi-host deployment would leave the shared cookie alive.
  // Expire the domain variant explicitly too. No-op when unset.
  const domain = sessionCookieDomain();
  if (domain) {
    cookieStore.set(COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: new Date(0),
      path: "/",
      domain,
    });
  }
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

type WebauthnChallengeInput = {
  challenge: string;
  // "register" = profile passkey enrollment; "auth" = passkey at the login 2FA
  // step; "login" = a discoverable passkey used as the complete login;
  // "stepup" = passkey satisfying an in-app action gate (require2FA).
  // Pinning the ceremony keeps a challenge from one flow being replayed into
  // another (e.g. a login-time "auth" challenge can't clear a money-action gate).
} & (
  | {
      type: "login";
      // Passwordless login resolves the account from the asserted discoverable
      // credential, so it intentionally has no user id before verification.
      adminUserId?: never;
    }
  | {
      type: "register" | "auth" | "stepup";
      adminUserId: string;
    }
);

type WebauthnChallengePayload = WebauthnChallengeInput & {
  expiresAt: string;
};

export async function createWebauthnChallenge(
  payload: WebauthnChallengeInput,
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
  /** Single-use nonce (SECURITY_AUDIT.md L-5). require2FA records this jti in the
   * admin DB on first use and rejects a token whose jti is already recorded, so
   * one step-up proof authorizes exactly one privileged action. Optional for
   * back-compat with tokens minted before this field (2-min TTL → the transition
   * window is tiny); a jti-less token verifies but isn't single-use-tracked. */
  jti?: string;
};

/** Mint a step-up proof token for `adminUserId`. Caller must have already
 * verified a passkey assertion for that same admin. Carries a random single-use
 * nonce so the proof clears exactly one action gate (consumed in require2FA). */
export async function createStepUpToken(adminUserId: string): Promise<string> {
  return encryptGeneric(
    { purpose: STEP_UP_PURPOSE, adminUserId, jti: crypto.randomUUID() },
    STEP_UP_TOKEN_TTL,
  );
}

/** Validate a step-up proof for `adminUserId` and return its single-use nonce
 * (`jti`, or null for a legacy jti-less token), or null when the string is not a
 * currently-valid proof (missing/expired/tampered token, wrong purpose, or one
 * minted for a different admin). Never throws, so callers can treat a non-token
 * string (e.g. a 6-digit TOTP code) as simply "not a proof". Consuming the jti
 * (single-use enforcement) is the caller's responsibility — see require2FA. */
export async function verifyStepUpToken(
  token: string,
  adminUserId: string,
): Promise<{ jti: string | null } | null> {
  const payload = await decryptGeneric<StepUpTokenPayload>(token);
  if (
    !payload ||
    payload.purpose !== STEP_UP_PURPOSE ||
    payload.adminUserId !== adminUserId
  ) {
    return null;
  }
  return { jti: payload.jti ?? null };
}

// --- Admin/owner passkey grace (10-min signed HttpOnly cookie) ---

const PASSKEY_GRACE_PURPOSE = "admin_passkey_grace";

type PasskeyGracePayload = {
  purpose: typeof PASSKEY_GRACE_PURPOSE;
  adminUserId: string;
  expiresAt: string;
};

/**
 * Start the reusable passkey window after a verified WebAuthn assertion.
 * Eligibility is checked by the caller before minting and again by require2FA
 * before use; this cookie only carries the cryptographic proof.
 */
export async function createPasskeyGrace(
  adminUserId: string,
): Promise<{ expiresAt: string }> {
  const expiresAt = new Date(Date.now() + PASSKEY_GRACE_TTL_MS);
  const expiresAtIso = expiresAt.toISOString();
  const token = await encryptGeneric(
    {
      purpose: PASSKEY_GRACE_PURPOSE,
      adminUserId,
      expiresAt: expiresAtIso,
    },
    "10m",
  );
  const cookieStore = await cookies();
  cookieStore.set(PASSKEY_GRACE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
    domain: sessionCookieDomain(),
  });
  return { expiresAt: expiresAtIso };
}

/** Validate the signed grace proof and bind it to the current admin account. */
export async function getPasskeyGrace(
  adminUserId: string,
): Promise<{ expiresAt: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(PASSKEY_GRACE_COOKIE)?.value;
  if (!token) return null;
  const payload = await decryptGeneric<PasskeyGracePayload>(token);
  if (
    !payload ||
    payload.purpose !== PASSKEY_GRACE_PURPOSE ||
    payload.adminUserId !== adminUserId ||
    !payload.expiresAt ||
    new Date(payload.expiresAt).getTime() <= Date.now()
  ) {
    return null;
  }
  return { expiresAt: payload.expiresAt };
}

export async function deletePasskeyGrace(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(PASSKEY_GRACE_COOKIE);
  const domain = sessionCookieDomain();
  if (domain) {
    cookieStore.set(PASSKEY_GRACE_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: new Date(0),
      path: "/",
      domain,
    });
  }
}

