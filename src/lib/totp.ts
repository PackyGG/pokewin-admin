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
