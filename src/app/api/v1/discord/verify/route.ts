import { z } from "zod";
import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getProdDrizzleDb } from "@/lib/db";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";

/**
 * POST /api/v1/discord/verify — the bot's `/verify` command.
 *
 * Confirms a Discord account is linked to a Packy account AND records that
 * the player has been through verification, so the bot can tell a first-time
 * verify from a repeat ("you're already verified — since 3 May").
 *
 * ── WHY THIS ISN'T `/discord/linked` ──────────────────────────────────────
 * `/discord/linked` is a pure READ under a read-only scope. This endpoint
 * WRITES (the verification record), so it carries its own write scope
 * `discord:verify`. Folding the write into the read endpoint would quietly
 * break the surface's rule that a read scope never mutates anything — see
 * `src/lib/api-auth/scopes.ts`. Keep them separate: `/linked` to ask,
 * `/verify` to act.
 *
 * ── WHAT IS AND ISN'T RECORDED ────────────────────────────────────────────
 * The record is written ONLY on a successful verify. A failed one (unlinked
 * account) writes nothing, so the table never accumulates rows for Discord
 * ids that were merely probed. `first_verified_at` never moves once set —
 * that timestamp IS the "have they done it already?" answer; `verify_count`
 * and `last_verified_at` track repeats.
 *
 * DATA BOUNDARY: reads prod read-only through the pinned Drizzle client — a
 * machine caller must always see prod, not an admin's dev/prod cookie
 * toggle), writes the ADMIN DB only. Nothing here mutates the game DB.
 *
 * PRIVACY: like `/discord/linked`, the response carries no profile data — no
 * Packy user id, username, email or balance. A leaked bot token still cannot
 * enumerate or profile players.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deliberately NOT `.strict()`.
 *
 * Rejecting unknown keys sounds like hardening but buys nothing here: fields
 * we don't declare are never read, so ignoring them is exactly as safe as
 * refusing them. What it DOES do is break every caller that sends harmless
 * extra context — a Discord bot forwarding a guild id, an interaction id or a
 * username alongside the payload — turning a working integration into a 400
 * on every request. That is precisely what happened on 2026-07-22: `.strict()`
 * shipped at 23:50 and every endpoint began failing for the live bot.
 *
 * The real validation is below and is unchanged: the Discord id must be a
 * numeric snowflake, and a claim id must be a well-formed prefixed UUID.
 */
const BodySchema = z.object({
  discordUserId: z
    .string()
    .trim()
    .regex(/^\d{15,21}$/, "discordUserId must be a numeric Discord user ID"),
});

export const POST = withApiKey(
  { scopes: ["discord:verify"] },
  async (request) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return apiError(400, "invalid_json", "Request body must be valid JSON.");
    }

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ??
          "Expected a JSON body of { discordUserId: string }.",
      );
    }

    const { discordUserId } = parsed.data;

    // Single index probe on the unique accountId. providerId is asserted so a
    // same-valued account on another provider can never be mistaken for a
    // Discord link.
    const account = (
      await getProdDrizzleDb().execute<{
        providerId: string;
        userId: string;
      }>(sql`
        SELECT "providerId", "userId"
        FROM account
        WHERE "accountId" = ${discordUserId}
        LIMIT 1
      `)
    ).rows[0];

    if (!account || account.providerId !== "discord") {
      // Deliberately writes nothing — an unlinked probe leaves no trace.
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }

    // One atomic upsert records the verification and reports whether this was
    // the first one, avoiding both the extra read and its concurrency race.
    const result = await adminDrizzle.execute<{
      first_verified_at: Date | string;
      verify_count: number;
      inserted: boolean;
    }>(sql`
      INSERT INTO discord_verifications (
        discord_user_id,
        user_id,
        first_verified_at,
        last_verified_at,
        verify_count
      )
      VALUES (${discordUserId}, ${account.userId}, NOW(), NOW(), 1)
      ON CONFLICT (discord_user_id) DO UPDATE
      SET
        user_id = EXCLUDED.user_id,
        last_verified_at = NOW(),
        verify_count = discord_verifications.verify_count + 1
      RETURNING
        first_verified_at,
        verify_count,
        (xmax = 0) AS inserted
    `);
    const record = result.rows[0];
    if (!record) {
      throw new Error("Discord verification upsert returned no row");
    }

    return {
      discordUserId,
      linked: true,
      /** False on the very first successful verify, true on every repeat. */
      alreadyVerified: !record.inserted,
      firstVerifiedAt: new Date(record.first_verified_at).toISOString(),
      verifyCount: record.verify_count,
    };
  },
);
