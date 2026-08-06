"use server";

import { createHash } from "node:crypto";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { queryMainRows } from "@/lib/drizzle-query";
import {
  decryptActiveServerSeed,
  generateKenoNextDraw,
  seedHashMatches,
} from "@/lib/keno/next-draw";
import { requireOwner } from "@/lib/owners";
import { TARGET_KENO_USER_ID, type RevealKenoNextPreviewResult } from "./types";

type ActiveSeedRow = {
  user_id: string;
  username: string | null;
  email: string | null;
  client_seed: string | null;
  server_seed: string | null;
  server_seed_hash: string | null;
  nonce: number | string | null;
  seed_updated_at: Date | string | null;
};

export async function revealKenoNextPreviewAction(): Promise<RevealKenoNextPreviewResult> {
  const session = await requireOwner();

  try {
    const rows = await queryMainRows<ActiveSeedRow[]>(
      `SELECT
         u.id AS user_id,
         u.username,
         u.email,
         s.client_seed,
         s.server_seed,
         s.server_seed_hash,
         s.nonce,
         s.updated_at AS seed_updated_at
       FROM "user" u
       LEFT JOIN active_seeds s ON s.user_id = u.id
       WHERE u.id = $1
       LIMIT 1`,
      TARGET_KENO_USER_ID,
    );
    const row = rows[0];
    if (!row) return { ok: false, error: "The fixed test user was not found." };
    if (
      !row.client_seed ||
      !row.server_seed ||
      !row.server_seed_hash ||
      row.nonce === null
    ) {
      return {
        ok: false,
        error: "This user does not have a complete active seed yet.",
      };
    }

    const nonce = Number(row.nonce);
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      return { ok: false, error: "The active seed nonce is invalid." };
    }

    const pepper = process.env.PEPPER;
    if (row.server_seed.startsWith("v2:") && !pepper) {
      console.error("[keno-next-preview] PEPPER is unavailable");
      return {
        ok: false,
        error: "The seed preview is not configured on this environment.",
      };
    }

    const serverSeed = decryptActiveServerSeed(row.server_seed, pepper ?? "");
    if (!seedHashMatches(serverSeed, row.server_seed_hash)) {
      console.error("[keno-next-preview] Active seed commitment mismatch");
      return {
        ok: false,
        error: "The active seed could not be verified safely.",
      };
    }

    const { drawnNumbers } = generateKenoNextDraw(
      serverSeed,
      row.client_seed,
      nonce,
    );
    const snapshotId = createHash("sha256")
      .update(`${row.server_seed_hash}:${row.client_seed}:${nonce}`)
      .digest("hex")
      .slice(0, 16);

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "keno_next_outcome_viewed",
      targetUserId: TARGET_KENO_USER_ID,
      metadata: {
        nonce,
        snapshotId,
        serverSeedHashPrefix: row.server_seed_hash.slice(0, 12),
      },
    });

    return {
      ok: true,
      preview: {
        targetUserId: TARGET_KENO_USER_ID,
        username: row.username,
        nonce,
        serverSeedHash: row.server_seed_hash,
        seedUpdatedAt: row.seed_updated_at
          ? new Date(row.seed_updated_at).toISOString()
          : null,
        snapshotId,
        drawnNumbers,
        revealedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error(
      "[keno-next-preview] Could not reveal the next draw:",
      error instanceof Error ? error.message : "unknown error",
    );
    return {
      ok: false,
      error: "Could not load the next Keno preview. Please retry.",
    };
  }
}
