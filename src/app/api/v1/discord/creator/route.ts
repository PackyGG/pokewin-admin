import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import {
  creator_reward_claims,
  creator_reward_programs,
} from "@/lib/db-schema/admin/schema";
import {
  account,
  affiliate_codes,
  user,
} from "@/lib/db-schema/main/schema";
import { getProdDrizzleDb } from "@/lib/db";
import { adminDrizzle } from "@/lib/drizzle";
import { toNumber } from "@/lib/utils/decimal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  discordUserId: z
    .string()
    .trim()
    .regex(/^\d{15,21}$/, "discordUserId must be a numeric Discord user ID"),
});

const round2 = (value: unknown): number =>
  Math.round(toNumber(value) * 100) / 100;

export const POST = withApiKey(
  { scopes: ["discord:creator:read"] },
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

    const db = getProdDrizzleDb();
    const [linked] = await db
      .select({
        providerId: account.providerId,
        userId: account.userId,
        role: user.role,
        roles: user.roles,
      })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(account.accountId, parsed.data.discordUserId))
      .limit(1);

    if (!linked || linked.providerId !== "discord") {
      return apiError(
        404,
        "not_linked",
        "That Discord account is not linked to a Packy account.",
      );
    }
    if (
      linked.role !== "creator" &&
      !(linked.roles ?? []).includes("creator")
    ) {
      return apiError(
        404,
        "program_not_found",
        "That Packy account is not a creator.",
      );
    }

    const [programRows, ownedCodes] = await Promise.all([
      adminDrizzle
        .select()
        .from(creator_reward_programs)
        .where(eq(creator_reward_programs.creator_user_id, linked.userId)),
      db
        .select({ code: affiliate_codes.code })
        .from(affiliate_codes)
        .where(eq(affiliate_codes.user_id, linked.userId))
        .orderBy(sql`${affiliate_codes.created_at} DESC`),
    ]);

    const configuredCodes = new Set(
      programRows.flatMap((program) =>
        (program.codes ?? []).map((code) => code.toUpperCase()),
      ),
    );
    const code =
      ownedCodes
        .map((row) => row.code.toUpperCase())
        .find((owned) => configuredCodes.has(owned)) ??
      ownedCodes[0]?.code.toUpperCase() ??
      null;

    if (!code) {
      return apiError(
        404,
        "program_not_found",
        "No creator code is configured for that account.",
      );
    }

    const statsResult = await db.execute<{
      players_total: string;
      players_active_7d: string;
      wager_all_time: string;
      wager_last_7d: string;
    }>(sql`
      SELECT
        COUNT(DISTINCT referred_user_id)::text AS players_total,
        COUNT(DISTINCT referred_user_id) FILTER (
          WHERE created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '7 days'
        )::text AS players_active_7d,
        COALESCE(SUM(wager_amount_usd::numeric), 0)::text AS wager_all_time,
        COALESCE(SUM(wager_amount_usd::numeric) FILTER (
          WHERE created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '7 days'
        ), 0)::text AS wager_last_7d
      FROM affiliate_code_usages
      WHERE UPPER(code) = ${code}
    `);

    const programIds = programRows.map((program) => program.id);
    const payoutRows =
      programIds.length === 0
        ? []
        : await adminDrizzle
            .select({
              status: creator_reward_claims.status,
              amount:
                sql<string>`COALESCE(SUM(${creator_reward_claims.amount_usd}), 0)::text`,
            })
            .from(creator_reward_claims)
            .where(
              and(
                inArray(creator_reward_claims.program_id, programIds),
                inArray(creator_reward_claims.status, ["approved", "pending"]),
              ),
            )
            .groupBy(creator_reward_claims.status);

    const programs = programRows.flatMap((program) => {
      const legs: Array<Record<string, string | number | boolean>> = [];
      if (program.threshold_usd != null && program.reward_usd != null) {
        legs.push({
          type: "wager",
          active: program.is_active,
          perThresholdUsd: round2(program.reward_usd),
          thresholdUsd: round2(program.threshold_usd),
          ...(program.vip_reward_usd == null
            ? {}
            : { vipPerThresholdUsd: round2(program.vip_reward_usd) }),
        });
      }
      if (program.lossback_pct != null && program.min_deposit_usd != null) {
        legs.push({
          type: "ftd_lossback",
          active: program.is_active,
          lossbackPct: round2(program.lossback_pct),
          minDepositUsd: round2(program.min_deposit_usd),
        });
      }
      return legs;
    });

    const stat = statsResult.rows[0];
    const payout = (status: "approved" | "pending") =>
      round2(payoutRows.find((row) => row.status === status)?.amount ?? 0);

    return {
      code,
      programs,
      players: {
        total: Number(stat?.players_total ?? 0),
        active7d: Number(stat?.players_active_7d ?? 0),
      },
      wagerUsd: {
        allTime: round2(stat?.wager_all_time ?? 0),
        last7d: round2(stat?.wager_last_7d ?? 0),
      },
      payoutsUsd: {
        approved: payout("approved"),
        pending: payout("pending"),
      },
    };
  },
);
