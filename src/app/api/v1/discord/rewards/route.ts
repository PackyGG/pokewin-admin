import { z } from "zod";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { getProdReadDrizzleDb } from "@/lib/db";
import {
  account,
  rakeback_claims,
  rakeback_config,
  rewards,
  user,
  user_rewards,
} from "@/lib/db-schema/main/schema";
import { toNumber } from "@/lib/utils/decimal";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { checkApiSubjectRateLimit } from "@/lib/api-auth/rate-limit";
import { computeAllEntitlements } from "@/lib/creator-vip/compute";
import { logError } from "@/lib/errors/logger";

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
 * • Read-only, and `getProdReadDrizzleDb()`: a machine caller must
 *   always read prod, never the admin's dev/prod cookie toggle.
 * • Both reads are per-user index hits — `user_rewards.user_id` FK and the
 *   `rakeback_claims_user_id_rakeback_type_period_start_unique` index. No scans.
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
    // 17–20 digits, matching the ONLY caller: the rewards bot validates
    // `^\d{17,20}$` before every request (adminApi.js) and its button ids parse
    // with the same bound. The old `{15,21}` was looser than anything that can
    // reach here, so it only widened the space of ids an attacker could probe.
    .regex(/^\d{17,20}$/, "discordUserId must be a numeric Discord user ID"),
});

/** Defensive bound on the payload for an account with a large grant history. */
const MAX_REWARD_ROWS = 50;

/**
 * Per-player ceiling for `/check`, ON TOP OF the key's own budget.
 *
 * The bot throttles this to 3/min per user — but that runs on the CLIENT side
 * of the trust boundary, so a leaked key ignores it entirely. Set well above
 * the bot's default (its limit is env-tunable) so no legitimate `/check` ever
 * 429s, while a single id can no longer be pulled hundreds of times a minute.
 * Raise this first if `LIMIT_CHECK_PER_MINUTE` is ever raised past it.
 */
const SUBJECT_LIMIT_PER_MIN = 15;

type ClaimableItem = {
  id: string;
  name: string;
  amount?: number;
  currency?: string;
  /**
   * Present on `vip_*` entries only. Those are the ONLY ids `/discord/claim`
   * accepts — everything else in this list is claimed on-site, so the bot can
   * use this flag to decide whether to offer a Claim button at all.
   */
  claimable?: boolean;
  /** Progress copy for a reward that isn't payable yet. */
  progress?: string;
  /**
   * Which kind of creator reward this is, on `vip_*` entries only:
   *   "wager"        — recurring, earned by wagering under the code
   *   "ftd_lossback" — one-off, a % back on a lost first deposit
   * The two need different wording, so the bot is told which it has rather
   * than having to infer it from the presence of other fields.
   */
  rewardType?: "wager" | "ftd_lossback";
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

    const subjectRate = await checkApiSubjectRateLimit(
      "discord-rewards",
      discordUserId,
      SUBJECT_LIMIT_PER_MIN,
    );
    if (!subjectRate.allowed) {
      return apiError(
        429,
        "rate_limited",
        "Too many requests for this Discord account. Try again shortly.",
        subjectRate,
      );
    }

    const db = getProdReadDrizzleDb();

    // Same single index probe as /discord/linked. providerId is asserted so a
    // same-valued account on another provider can't resolve to a Packy user.
    const [linkedAccount] = await db
      .select({
        providerId: account.providerId,
        userId: account.userId,
        code: user.affiliate_code,
        codeExpiresAt: user.affiliate_code_expires_at,
      })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(account.accountId, discordUserId))
      .limit(1);

    if (!linkedAccount || linkedAccount.providerId !== "discord") {
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }

    const userId = linkedAccount.userId;

    const [unopenedRewards, rakebackByCadence, rakebackConfig] =
      await Promise.all([
        db
          .select({
            id: user_rewards.id,
            reward_name: rewards.name,
            cash_amount: rewards.cash_amount,
          })
          .from(user_rewards)
          .innerJoin(rewards, eq(rewards.id, user_rewards.reward_id))
          .where(
            and(
              eq(user_rewards.user_id, userId),
              isNull(user_rewards.opened_at),
              eq(rewards.type, "one_time"),
            ),
          )
          .orderBy(asc(user_rewards.granted_at))
          .limit(MAX_REWARD_ROWS),
        db
          .select({
            rakeback_type: rakeback_claims.rakeback_type,
            rakeback_amount_usd:
              sql<string>`COALESCE(SUM(${rakeback_claims.rakeback_amount_usd}), 0)`,
          })
          .from(rakeback_claims)
          .where(
            and(
              eq(rakeback_claims.user_id, userId),
              isNull(rakeback_claims.claimed_at),
            ),
          )
          .groupBy(rakeback_claims.rakeback_type),
        // Operator-facing cadence labels ("Daily Rakeback"). Falls back to a
        // derived title if a cadence has no config row.
        db
          .select({
            type: rakeback_config.type,
            display_name: rakeback_config.display_name,
          })
          .from(rakeback_config),
      ]);

    const labelByCadence = new Map(
      rakebackConfig.map((row) => [row.type, row.display_name]),
    );

    const claimable: ClaimableItem[] = [];

    for (const row of unopenedRewards) {
      // cash_amount is nullable: many rewards grant PACKS, not cash. Emit the
      // amount only when there genuinely is one rather than implying $0.
      const cash = row.cash_amount;
      const amount = cash == null ? null : round2(toNumber(cash));
      claimable.push({
        id: `ur_${row.id}`,
        name: row.reward_name,
        ...(amount != null && amount > 0
          ? { amount, currency: "USD" }
          : {}),
      });
    }

    for (const row of rakebackByCadence) {
      const total = round2(toNumber(row.rakeback_amount_usd));
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

    // Creator VIP wager rewards. Unlike everything above — which the player
    // claims on-site — these are claimed THROUGH the bot, so they carry
    // `claimable: true` and their id is what /discord/claim expects.
    //
    // Entries with nothing ready yet are still listed, with `progress` copy:
    // "you're $340 away" is the whole point of the command, and dropping them
    // would make an engaged player look like they have no program at all.
    // This read is admin-DB + a per-user index probe per program, so it adds
    // no meaningful cost to the response.
    // Creator-reward offers are ISOLATED: this subsystem reads more tables
    // than the rest of the endpoint, and a player's rakeback and unopened
    // rewards must still be listed if it fails. A throw here would
    // otherwise 500 the entire /check command.
    let offers: Awaited<ReturnType<typeof computeAllEntitlements>> = [];
    try {
      offers = await computeAllEntitlements(userId);
    } catch (err) {
      logError("api.v1.discord.rewards", "creator-reward offers failed", err);
    }

    for (const e of offers) {
      if (e.blockedReason) continue;
      const ready = e.units > 0;
      // Progress wording is per TYPE. A lossback has no wager threshold, so the
      // wager copy would read "$0.00 more wagered" — true of the field, and
      // nonsense to the player.
      const progress =
        e.type === "ftd_lossback"
          ? "Nothing back yet — this pays a share of losses on your first deposit"
          : `$${e.wagerToNextUnitUsd.toFixed(2)} more wagered to unlock the next reward`;
      // The PREFIX carries the leg, so a program offering both produces two
      // independently claimable entries rather than one ambiguous id.
      claimable.push({
        id: `${e.type === "ftd_lossback" ? "ftd" : "vip"}_${e.programId}`,
        name: e.programName,
        rewardType: e.type,
        ...(ready
          ? { amount: e.amountUsd, currency: "USD", claimable: true }
          : { claimable: false, progress }),
      });
    }

    const codeExpiresAt = linkedAccount.codeExpiresAt
      ? new Date(linkedAccount.codeExpiresAt)
      : null;
    return {
      discordUserId,
      code: linkedAccount.code?.toUpperCase() ?? null,
      codeExpired:
        codeExpiresAt !== null && codeExpiresAt.getTime() <= Date.now(),
      claimable,
    };
  },
);
