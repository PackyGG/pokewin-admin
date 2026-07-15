import crypto from "crypto";

/**
 * Ports backend's `src/utils/server-seed-crypto.ts` (AES-256-GCM, HKDF-derived
 * key) and `src/utils/provably-fair.ts` (HMAC ticket generation) byte for
 * byte. Used only to recompute — never mutate — historical battle outcomes
 * for the EOS verification "show result" tool. Any drift from the backend
 * algorithm here would silently produce wrong verification results.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const V2_PREFIX = "v2:";
const HKDF_SALT = Buffer.from("packy-server-seed-encryption", "utf8");
const HKDF_INFO = Buffer.from("aes-256-gcm-key", "utf8");

const deriveKeyV1 = (pepper: string): Buffer =>
  crypto.createHash("sha256").update(pepper).digest();

const deriveKeyV2 = (pepper: string): Buffer =>
  Buffer.from(crypto.hkdfSync("sha256", pepper, HKDF_SALT, HKDF_INFO, 32));

export function decryptServerSeed(encryptedSeed: string, pepper: string): string {
  const isV2 = encryptedSeed.startsWith(V2_PREFIX);
  const encoded = isV2 ? encryptedSeed.slice(V2_PREFIX.length) : encryptedSeed;
  const key = isV2 ? deriveKeyV2(pepper) : deriveKeyV1(pepper);

  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

export const MAX_TICKET = 1_000_000;

export function generateResultHash(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  cursor = 0,
): string {
  const hmac = crypto.createHmac("sha256", serverSeed);
  hmac.update(`${clientSeed}:${nonce}:${cursor}`);
  return hmac.digest("hex");
}

export function generateProvablyFairInt(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  cursor = 0,
): { ticket: number; hash: string } {
  const hash = generateResultHash(serverSeed, clientSeed, nonce, cursor);
  const hashInt = BigInt("0x" + hash);
  const ticket = Number((hashInt % BigInt(MAX_TICKET)) + BigInt(1));
  return { ticket, hash };
}
