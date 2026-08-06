import {
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";

import { KENO_DRAW_COUNT, KENO_GRID_SIZE } from "@/lib/keno/payouts";

const V2_PREFIX = "v2:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = Buffer.from("packy-server-seed-encryption", "utf8");
const HKDF_INFO = Buffer.from("aes-256-gcm-key", "utf8");

export function decryptActiveServerSeed(
  storedSeed: string,
  pepper: string,
): string {
  if (!storedSeed.startsWith(V2_PREFIX)) return storedSeed;

  const encrypted = Buffer.from(storedSeed.slice(V2_PREFIX.length), "base64");
  if (encrypted.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted seed payload");
  }

  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(encrypted.length - TAG_LENGTH);
  const ciphertext = encrypted.subarray(
    IV_LENGTH,
    encrypted.length - TAG_LENGTH,
  );
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(pepper, "utf8"), HKDF_SALT, HKDF_INFO, 32),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function hashServerSeed(serverSeed: string): string {
  return createHash("sha256").update(serverSeed).digest("hex");
}

export function seedHashMatches(
  serverSeed: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashServerSeed(serverSeed), "utf8");
  const expected = Buffer.from(expectedHash.trim().toLowerCase(), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateKenoNextDraw(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
): { drawnNumbers: number[]; resultHash: string } {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error("Invalid active seed nonce");
  }

  const resultHash = createHmac("sha256", serverSeed)
    .update(`${clientSeed}:${nonce}:0`)
    .digest("hex");
  const pool = Array.from({ length: KENO_GRID_SIZE }, (_, index) => index);
  const drawnNumbers: number[] = [];

  for (let index = 0; index < KENO_DRAW_COUNT; index += 1) {
    const value = Number.parseInt(
      resultHash.slice(index * 5, index * 5 + 5),
      16,
    );
    const poolIndex = value % pool.length;
    drawnNumbers.push(pool.splice(poolIndex, 1)[0]);
  }

  drawnNumbers.sort((left, right) => left - right);
  return { drawnNumbers, resultHash };
}
