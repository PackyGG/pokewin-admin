import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { getProdDb } from "@/lib/db";
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
 * DATA BOUNDARY: reads prod read-only (`getProdDb()`, never `getDb()` — a
 * machine caller must always see prod, not an admin's dev/prod cookie
 * toggle), writes the ADMIN DB only. Nothing here mutates the game DB.
 *
 * PRIVACY: like `/discord/linked`, the response carries no profile data — no
 * Packy user id, username, email or balance. A leaked bot token still cannot
 * enumerate or profile players.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const account = await getProdDb().account.findUnique({
      where: { accountId: discordUserId },
      select: { providerId: true, userId: true },
    });

    if (!account || account.providerId !== "discord") {
      // Deliberately writes nothing — an unlinked probe leaves no trace.
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }

    // Read-before-write so we can tell the bot whether this was their FIRST
    // verify. The upsert below is what actually guarantees correctness under
    // concurrency (unique on discord_user_id); this read only decides the
    // message, so a race at worst mislabels a simultaneous double-verify as
    // "first" twice — it can never create a duplicate row or lose a count.
    const existing = await adminDb.discord_verifications.findUnique({
      where: { discord_user_id: discordUserId },
      select: { first_verified_at: true, verify_count: true },
    });

    const now = new Date();
    const record = await adminDb.discord_verifications.upsert({
      where: { discord_user_id: discordUserId },
      create: {
        discord_user_id: discordUserId,
        user_id: account.userId,
        first_verified_at: now,
        last_verified_at: now,
        verify_count: 1,
      },
      update: {
        // user_id is refreshed in case the Discord account was relinked to a
        // different Packy account since the last verify.
        user_id: account.userId,
        last_verified_at: now,
        verify_count: { increment: 1 },
        // first_verified_at is deliberately NOT touched.
      },
      select: { first_verified_at: true, verify_count: true },
    });

    return {
      discordUserId,
      linked: true,
      /** False on the very first successful verify, true on every repeat. */
      alreadyVerified: existing !== null,
      firstVerifiedAt: record.first_verified_at.toISOString(),
      verifyCount: record.verify_count,
    };
  },
);
