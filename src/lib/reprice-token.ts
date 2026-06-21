import { SignJWT, jwtVerify } from "jose";

/**
 * Short-lived, signed authorization for a re-price RUN.
 *
 * Why a token: the re-price runs pack-by-pack (one server-action call per pack
 * so the UI shows real progress). We don't want to re-prompt TOTP on every
 * pack, and re-checking the same 6-digit TOTP repeatedly is fragile (codes roll
 * every 30s and a long run would fail mid-way). Instead the owner passes TOTP
 * ONCE to `authorizeReprice`, which verifies it and mints this token; each
 * per-pack write then verifies the token. The token is signed with
 * SESSION_SECRET (server-only, unforgeable), scoped to one user, and expires in
 * 15 minutes — long enough for a full run, short enough to not linger.
 */
const SCOPE = "reprice";
const TTL = "15m";

function key(): Uint8Array {
  return new TextEncoder().encode(process.env.SESSION_SECRET!);
}

/** Mint a re-price authorization token for `userId` (call AFTER verifying TOTP). */
export async function signRepriceToken(userId: string): Promise<string> {
  return new SignJWT({ scope: SCOPE, uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(key());
}

/** True iff `token` is a valid, unexpired re-price token for `userId`. */
export async function verifyRepriceToken(
  token: string,
  userId: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload.scope === SCOPE && payload.uid === userId;
  } catch {
    return false;
  }
}

/**
 * Short-lived, signed authorization for a pack RETUNE — a DISTINCT scope from
 * the re-price token above.
 *
 * Why a separate scope: a re-price only moves a pack's sticker `price`; a retune
 * rewrites the pack's per-card WEIGHTS (the odds themselves). They are different
 * blast radii, so a token minted for one must never authorize the other. Same
 * mechanics as the re-price token (signed with SESSION_SECRET, scoped to one
 * user, 15-minute TTL) but its own `RETUNE_SCOPE`, so `verifyRetuneToken` will
 * reject a re-price token and vice-versa.
 */
const RETUNE_SCOPE = "retune";

/** Mint a pack-retune authorization token for `userId` (call AFTER verifying TOTP). */
export async function signRetuneToken(userId: string): Promise<string> {
  return new SignJWT({ scope: RETUNE_SCOPE, uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(key());
}

/** True iff `token` is a valid, unexpired pack-retune token for `userId`. */
export async function verifyRetuneToken(
  token: string,
  userId: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return payload.scope === RETUNE_SCOPE && payload.uid === userId;
  } catch {
    return false;
  }
}
