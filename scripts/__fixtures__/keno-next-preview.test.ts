import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

import {
  decryptActiveServerSeed,
  generateKenoNextDraw,
  hashServerSeed,
  seedHashMatches,
  toPlayerFacingKenoNumbers,
} from "@/lib/keno/next-draw";

const TARGET_USER_ID = "Fj6ga9pNFr5BpJL0PEVKobW3xZmhdl9F";

function encryptV2(plainText: string, pepper: string): string {
  const iv = randomBytes(12);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(pepper, "utf8"),
      Buffer.from("packy-server-seed-encryption", "utf8"),
      Buffer.from("aes-256-gcm-key", "utf8"),
      32,
    ),
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  return `v2:${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64")}`;
}

test("Keno next draw matches the backend HMAC selection contract", () => {
  const result = generateKenoNextDraw(
    "server-seed-test",
    "client-seed-test",
    42,
  );

  assert.equal(
    result.resultHash,
    "bd264e592ba835437414c9e775db9313a6e6989a95861913ebda2ee43497c237",
  );
  assert.deepEqual(result.drawnNumbers, [1, 2, 3, 5, 9, 14, 19, 20, 34, 36]);
  assert.deepEqual(
    toPlayerFacingKenoNumbers(result.drawnNumbers),
    [2, 3, 4, 6, 10, 15, 20, 21, 35, 37],
  );
});

test("Keno preview maps backend indexes to the same 1–40 labels as the game", () => {
  assert.deepEqual(
    toPlayerFacingKenoNumbers([0, 1, 3, 11, 14, 19, 33, 34, 38, 39]),
    [1, 2, 4, 12, 15, 20, 34, 35, 39, 40],
  );
});

test("Keno active seed decryption mirrors backend v2 and plaintext behavior", () => {
  const seed = "secret-server-seed";
  const pepper = "test-only-pepper";

  assert.equal(decryptActiveServerSeed(seed, pepper), seed);
  assert.equal(decryptActiveServerSeed(encryptV2(seed, pepper), pepper), seed);
  assert.throws(() =>
    decryptActiveServerSeed(encryptV2(seed, pepper), "wrong"),
  );
});

test("Keno seed commitment is verified before previewing", () => {
  const seed = "committed-seed";
  assert.equal(seedHashMatches(seed, hashServerSeed(seed)), true);
  assert.equal(seedHashMatches(seed, "0".repeat(64)), false);
});

test("Keno preview is fixed, owner-gated, audited, and draw-only", async () => {
  const root = process.cwd();
  const [actionSource, clientSource, pageSource, typeSource] =
    await Promise.all([
      readFile(
        join(root, "src/app/(admin)/system/keno-next-preview/actions.ts"),
        "utf8",
      ),
      readFile(
        join(
          root,
          "src/app/(admin)/system/keno-next-preview/keno-next-preview-client.tsx",
        ),
        "utf8",
      ),
      readFile(
        join(root, "src/app/(admin)/system/keno-next-preview/page.tsx"),
        "utf8",
      ),
      readFile(
        join(root, "src/app/(admin)/system/keno-next-preview/types.ts"),
        "utf8",
      ),
    ]);

  assert.match(typeSource, new RegExp(TARGET_USER_ID));
  assert.match(actionSource, /await requireOwner\(\)/);
  assert.match(pageSource, /await requireOwner\(\)/);
  assert.match(actionSource, /keno_next_outcome_viewed/);
  assert.match(
    actionSource,
    /seedHashMatches\(serverSeed, row\.server_seed_hash\)/,
  );
  assert.doesNotMatch(typeSource, /serverSeed:/);
  assert.doesNotMatch(typeSource, /clientSeed:/);
  assert.match(clientSource, /Array\.from\(\{ length: KENO_GRID_SIZE \}/);
  assert.match(clientSource, /drawnSet\.has\(number\)/);
  assert.doesNotMatch(
    clientSource,
    /selectedNumbers|getKenoMultiplier|betInput/,
  );
});
