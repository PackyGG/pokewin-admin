import "server-only";

import { headers } from "next/headers";
import { APP_HOSTS, ROOT_DOMAIN, resolveAppHost } from "@/lib/app-hosts";
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
// MULTI-HOST (packydash.com + packs./fraud./marketing. sub-domains).
//
// A passkey is bound to its RP ID, and the browser only offers it when the RP
// ID is the page's own domain OR a registrable parent of it. So with the app
// served from four hostnames there is exactly one correct RP ID: the shared
// parent, `packydash.com`. Pinning it to any single sub-domain would make
// passkeys registered there unusable on the other three; leaving it derived
// per-host would mint four INCOMPATIBLE credentials for one account, so a
// passkey enrolled on the apex simply wouldn't appear on fraud.packydash.com.
//
// The ORIGIN is a different check: it must match the page the assertion came
// from EXACTLY (scheme + host + port), so a single value can't cover four
// hosts. @simplewebauthn accepts a LIST, which is the supported way to run one
// RP across several origins — `expectedOrigin` below is that list.
//
// Resolution order, most explicit first:
//   1. `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` env (origin accepts a
//      comma-separated list) — the pin, used in production.
//   2. The app-host map, when the request arrives on a known dashboard host —
//      RP ID becomes the registrable parent and every dashboard origin is
//      accepted.
//   3. The raw request host — preview deploys and localhost, unchanged.
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

type RpConfig = {
  rpName: string;
  rpID: string;
  /**
   * Every origin an assertion may legitimately come from. A single-element
   * list is the normal single-domain case; the multi-host deployment supplies
   * one entry per dashboard hostname.
   */
  origins: string[];
};

async function getRpConfig(): Promise<RpConfig> {
  const h = await headers();
  const host = h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  const envRpId = process.env.WEBAUTHN_RP_ID?.trim();
  // Comma-separated so one env var covers every host.
  const envOrigins = (process.env.WEBAUTHN_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const requestOrigin = `${proto}://${host}`;
  const appHost = resolveAppHost(host);

  // RP ID: the explicit pin, else the shared registrable parent when this is a
  // known dashboard host, else the request's own hostname.
  const rpID =
    envRpId || (appHost ? ROOT_DOMAIN : host.split(":")[0] || "localhost");

  // Origins: the explicit list, else every dashboard origin when on a known
  // host (so a passkey works on all four), else just this request's origin.
  let origins: string[];
  if (envOrigins.length > 0) {
    origins = envOrigins;
  } else if (appHost) {
    origins = APP_HOSTS.map((entry) => `https://${entry.host}`);
  } else {
    origins = [requestOrigin];
  }

  // Accept the origin this request came in on — but ONLY when no explicit pin
  // is configured. An operator who pinned the list gets exactly that list;
  // widening it from a request header would let a spoofed Host re-open what
  // the pin deliberately closed. Unpinned (preview deploys, localhost) it just
  // means the current host works without configuration.
  if (envOrigins.length === 0 && !origins.includes(requestOrigin)) {
    origins.push(requestOrigin);
  }

  return { rpName: RP_NAME, rpID, origins };
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
  const { rpID, origins } = await getRpConfig();
  return verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: origins,
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
  const { rpID, origins } = await getRpConfig();
  return verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: origins,
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
