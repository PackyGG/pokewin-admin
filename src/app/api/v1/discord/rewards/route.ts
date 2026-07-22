import { z } from "zod";

import { getProdDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";

/**
 * POST /api/v1/discord/rewards — what can this Discord-linked player claim?
 *
 * Powers the rewards bot's `/check` command. Takes ONLY a Discord user ID and
 * resolves the Packy account server-side, because `/discord/linked`
 * deliberately returns a boolean — the bot never holds a Packy identifier.
 *
 * ── WHAT COUNTS AS "CLAIMABLE" ────────────────────────────────────────────
 * Both sources below mirror the ONLY claimability logic that already exists
 * and is verified in this codebase (`getUserRewards`, users-rewards.ts). That
 * is deliberate: this figure is shown to a player in Discord, so it must not
 * be a second, hand-rolled definition that can drift from the admin UI.
 *
 *   1. `user_rewards` with `opened_at IS NULL` **and `rewards.type = one_time`**.
 *      Restricted to one_time on purpose — `daily` and `balance` rewards are
 *      recurring and their availability depends on the daily-unlock rule
 *      (`daily_period_start` + `daily_unlock_xp_baseline` +
 *      `daily_unlock_percentage`), NOT on `opened_at`. Listing an unopened
 *      daily row would tell a player they can claim something that has not
 *      unlocked yet. `openOneTimeCount` applies exactly this filter.
 *
 *   2. `rakeback_claims` with `claimed_at IS NULL`, SUMMED per cadence.
 *      Matches `rakebackClaimableUsd`. Aggregated rather than per-row because a
 *      player accrues one row per period — dozens of "$0.02" lines would be
 *      noise in a Discord reply.
 *
 * NOT a source: `race_claims` / `affiliate_leaderboard_claims` — their
 * `claimed_at` is NON-nullable, so a row only exists once already claimed.
 *
 * ── NO expiresAt ──────────────────────────────────────────────────────────
 * No reward or claim table has an expiry column. Expiry is a global rule
 * (`rakeback_config.expiration_days`), not a per-row timestamp, so the field is
 * omitted rather than fabricated. The bot spec treats it as optional.
 *
 * ── OTHER CONTRACT NOTES ──────────────────────────────────────────────────
 * • Empty is SUCCESS: nothing to claim → 200 with `claimable: []`.
 * • Unlinked → 404 `not_linked`, NOT an empty array. An empty array would tell
 *   an unlinked player "you have nothing", which is exactly the failure the bot
 *   must be able to distinguish.
 * • POST so the Discord ID stays out of access / proxy / error logs.
 * • Read-only, and `getProdDb()` (never `getDb()`): a machine caller must
 *   always read prod, never the admin's dev/prod cookie toggle.
 * • Both reads are per-user index hits — `user_rewards.user_id` FK and the
 *   `rakeback_claims_user_id_rakeback_type_period_start_unique` index. No scans.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  discordUserId: z
    .string()
    .trim()
    .regex(/^\d{15,21}$/, "discordUserId must be a numeric Discord user ID"),
});

/** Defensive bound on the payload for an account with a large grant history. */
const MAX_REWARD_ROWS = 50;

type ClaimableItem = {
  id: string;
  name: string;
  amount?: number;
  currency?: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const titleCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

export const POST = withApiKey(
  { scopes: ["discord:rewards:read"] },
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
    const db = getProdDb();

    // Same single index probe as /discord/linked. providerId is asserted so a
    // same-valued account on another provider can't resolve to a Packy user.
    const account = await db.account.findUnique({
      where: { accountId: discordUserId },
      select: { providerId: true, userId: true },
    });

    if (!account || account.providerId !== "discord") {
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }

    const userId = account.userId;

    const [unopenedRewards, rakebackByCadence, rakebackConfig] =
      await Promise.all([
        db.user_rewards.findMany({
          where: {
            user_id: userId,
            opened_at: null,
            rewards: { type: "one_time" },
          },
          select: {
            id: true,
            rewards: { select: { name: true, cash_amount: true } },
          },
          orderBy: { granted_at: "asc" },
          take: MAX_REWARD_ROWS,
        }),
        db.rakeback_claims.groupBy({
          by: ["rakeback_type"],
          where: { user_id: userId, claimed_at: null },
          _sum: { rakeback_amount_usd: true },
        }),
        // Operator-facing cadence labels ("Daily Rakeback"). Falls back to a
        // derived title if a cadence has no config row.
        db.rakeback_config.findMany({
          select: { type: true, display_name: true },
        }),
      ]);

    const labelByCadence = new Map(
      rakebackConfig.map((row) => [row.type, row.display_name]),
    );

    const claimable: ClaimableItem[] = [];

    for (const row of unopenedRewards) {
      // cash_amount is nullable: many rewards grant PACKS, not cash. Emit the
      // amount only when there genuinely is one rather than implying $0.
      const cash = row.rewards.cash_amount;
      const amount = cash == null ? null : round2(toNumber(cash));
      claimable.push({
        id: `ur_${row.id}`,
        name: row.rewards.name,
        ...(amount != null && amount > 0
          ? { amount, currency: "USD" }
          : {}),
      });
    }

    for (const row of rakebackByCadence) {
      const total = round2(toNumber(row._sum.rakeback_amount_usd ?? 0));
      if (total <= 0) continue;
      claimable.push({
        id: `rb_${row.rakeback_type}`,
        name:
          labelByCadence.get(row.rakeback_type) ??
          `${titleCase(row.rakeback_type)} Rakeback`,
        amount: total,
        currency: "USD",
      });
    }

    return { discordUserId, claimable };
  },
);
