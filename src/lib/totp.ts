import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const ISSUER = "Packy.gg Admin";

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function generateTOTPUri(secret: string, email: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  return totp.toString();
}

export async function generateQRCode(uri: string): Promise<string> {
  return QRCode.toDataURL(uri);
}

export function verifyTOTP(secret: string, token: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

/**
 * Verify a TOTP code and return its INTRINSIC step (the HOTP counter the code
 * was generated for), or null if invalid. The step is stable for a given code
 * regardless of when it is checked within its ±1 window, so it can be used as a
 * single-use watermark: `require2FA` records the last consumed step and rejects
 * a code whose step was already used (SECURITY_AUDIT.md MEDIUM-5).
 *
 * `validate` returns the offset (delta) of the matched step from the current
 * time-step; the absolute step is `currentStep + delta`, which equals the
 * code's own counter — identical no matter when it matched.
 */
export function verifyTOTPWithStep(secret: string, token: string): number | null {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1 });
  if (delta === null) return null;
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  return currentStep + delta;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

export async function verifyRecoveryCode(
  code: string,
  hashes: string[]
): Promise<number> {
  for (let i = 0; i < hashes.length; i++) {
    const match = await bcrypt.compare(code, hashes[i]);
    if (match) return i;
  }
  return -1;
}
