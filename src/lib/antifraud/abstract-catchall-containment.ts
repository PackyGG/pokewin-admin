import "server-only";

import { sql } from "drizzle-orm";

import { getProdPrimaryDrizzleDb } from "@/lib/db";

/**
 * Ban for `abstract_email_catchall` when Abstract confirmed a catch-all
 * signup domain. Never mutates KYC.
 *
 * Pure target + MAIN apply split so admission runs inside the ADMIN ingest
 * transaction and the ban runs only after commit via the outbox.
 */

export type AbstractCatchallContainmentTarget = {
  userId: string;
  domain: string;
  reason: string;
};

function normalizedDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) &&
    domain.includes(".")
    ? domain
    : null;
}

/**
 * Pure admission check — safe inside the ADMIN ingest transaction.
 */
export function abstractCatchallContainmentTarget(signal: {
  userId?: string | null;
  payload?: Record<string, unknown> | null;
}): AbstractCatchallContainmentTarget | null {
  const userId = signal.userId;
  const domain = normalizedDomain(signal.payload?.emailDomain);
  if (
    !userId ||
    !domain ||
    signal.payload?.containmentRequired !== true ||
    signal.payload?.provider !== "abstract_email"
  ) {
    return null;
  }

  return {
    userId,
    domain,
    reason: (
      `Automatic fraud ban: signup used an Abstract-confirmed catch-all email domain (${domain})`
    ).slice(0, 500),
  };
}

/**
 * Ban + kill sessions in MAIN. `"banned"` is applied containment for the
 * outbox (mapped to `"locked"` / `applied`); `"skipped"` is permanent.
 */
export async function applyAbstractCatchallContainment(
  target: AbstractCatchallContainmentTarget,
): Promise<"banned" | "skipped"> {
  const db = getProdPrimaryDrizzleDb();
  const banned = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE "user"
      SET
        is_banned = TRUE,
        banned_reason = CASE
          WHEN is_banned THEN COALESCE(banned_reason, ${target.reason})
          ELSE ${target.reason}
        END,
        banned_at = CASE
          WHEN is_banned THEN COALESCE(banned_at, NOW())
          ELSE NOW()
        END,
        banned_by = CASE WHEN is_banned THEN banned_by ELSE NULL END,
        updated_at = NOW()
      WHERE id = ${target.userId}
      RETURNING id
    `);
    if (rows.rows.length === 0) return false;
    await tx.execute(
      sql`DELETE FROM session WHERE "userId" = ${target.userId}`,
    );
    return true;
  });
  return banned ? "banned" : "skipped";
}
