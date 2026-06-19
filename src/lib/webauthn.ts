import "server-only";

import { headers } from "next/headers";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";

// ---------------------------------------------------------------------------
// WebAuthn (passkey) server helpers — used ONLY as an alternative second factor
// at the 2FA verification step (password stays factor one; TOTP enrollment is
// unchanged). Thin wrappers over @simplewebauthn/server so the RP config is
// resolved once and the call sites stay declarative.
//
// RP ID + origin are derived from the incoming request `host` header so this
// works on prod (pokewin-admin.vercel.app), localhost, and preview deploys with
// no hardcoding. `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` env vars override the
// derivation if ever needed (e.g. a custom domain). The RP ID MUST be the bare
// registrable domain (no scheme, no port); the origin is scheme + host (+port).
// ---------------------------------------------------------------------------

const RP_NAME = "Packy.gg Admin";

/**
 * Copy bytes into a fresh ArrayBuffer-backed Uint8Array. Prisma `Bytes` come
 * back as a Node Buffer (Uint8Array<ArrayBufferLike>), but the library's
 * credential type wants the narrower Uint8Array<ArrayBuffer> — `new
 * Uint8Array(length)` produces exactly that.
 */
function toArrayBufferBacked(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

type RpConfig = { rpName: string; rpID: string; origin: string };

async function getRpConfig(): Promise<RpConfig> {
  const h = await headers();
  const host = h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const envRpId = process.env.WEBAUTHN_RP_ID?.trim();
  const envOrigin = process.env.WEBAUTHN_ORIGIN?.trim();

  const rpID = envRpId || host.split(":")[0] || "localhost";
  const origin = envOrigin || `${proto}://${host}`;
  return { rpName: RP_NAME, rpID, origin };
}

/** A stored credential as the verification helpers need it. */
export type StoredCredential = {
  credentialId: string; // base64url
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

export async function buildRegistrationOptions(args: {
  userId: string;
  userName: string;
  userDisplayName: string;
  existing: { credentialId: string; transports: string[] }[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpName, rpID } = await getRpConfig();
  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: args.userName,
    userID: new TextEncoder().encode(args.userId),
    userDisplayName: args.userDisplayName,
    attestationType: "none",
    excludeCredentials: args.existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

export async function checkRegistration(args: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<VerifiedRegistrationResponse> {
  const { rpID, origin } = await getRpConfig();
  return verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    // This is a SECOND factor (after password) — a roaming security key may
    // only assert user presence, so don't hard-require user verification.
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(args: {
  allowCredentials: { credentialId: string; transports: string[] }[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = await getRpConfig();
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: args.allowCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: "preferred",
  });
}

export async function checkAuthentication(args: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: StoredCredential;
}): Promise<VerifiedAuthenticationResponse> {
  const { rpID, origin } = await getRpConfig();
  return verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: args.credential.credentialId,
      publicKey: toArrayBufferBacked(args.credential.publicKey),
      counter: args.credential.counter,
      transports: args.credential.transports as AuthenticatorTransportFuture[],
    },
    requireUserVerification: false,
  });
}
