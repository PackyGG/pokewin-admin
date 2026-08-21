"use server";

import { revalidatePath } from "next/cache";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  deleteEosUserConfig,
  eosUserRuleSchema,
  getEosTestConfig,
  updateEosTestConfig,
  updateEosUserConfig,
} from "@/lib/antifraud/eos-test-config-api";
import { getBattleTestDevReadDrizzleDb } from "@/lib/battle-test-dev-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { escapeLikePattern } from "@/lib/utils/sql-like";

const saveFlowSchema = z.object({
  rules: z.array(eosUserRuleSchema).min(1).max(20),
  persistent: z.boolean(),
  randomized: z.boolean(),
  enabled: z.boolean(),
}).refine((flow) => !flow.randomized || flow.persistent);

export async function saveGlobalEosFlow(input: unknown) {
  const session = await requireEosTestAccess();
  const flow = saveFlowSchema.parse(input);
  const saved = await updateEosTestConfig({
    ...flow,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function searchEosUsers(input: unknown) {
  await requireEosTestAccess();
  const query = z.string().trim().min(2).max(100).parse(input);
  const config = await getEosTestConfig();
  const db = config.environment === "prod"
    ? getProdReadDrizzleDb()
    : getBattleTestDevReadDrizzleDb();
  const prefix = `${escapeLikePattern(query.toLowerCase())}%`;
  const rows = await db
    .select({
      userId: user.id,
      username: user.username,
      displayUsername: user.display_username,
    })
    .from(user)
    .where(
      or(
        eq(user.id, query),
        sql`LOWER(${user.username}) LIKE ${prefix} ESCAPE '\'`,
        sql`LOWER(${user.display_username}) LIKE ${prefix} ESCAPE '\'`,
      ),
    )
    .limit(10);
  return rows;
}

const saveUserConfigSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  username: z.string().trim().min(1).max(100).nullable(),
  rules: z.array(eosUserRuleSchema).min(1).max(20),
  persistent: z.boolean(),
  randomized: z.boolean(),
  enabled: z.boolean(),
});

export async function saveEosUserConfig(input: unknown) {
  const session = await requireEosTestAccess();
  const parsed = saveUserConfigSchema
    .refine((flow) => !flow.randomized || flow.persistent)
    .parse(input);
  const saved = await updateEosUserConfig({
    ...parsed,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function removeEosUserConfig(input: unknown) {
  await requireEosTestAccess();
  const userId = z.string().trim().min(1).max(100).parse(input);
  await deleteEosUserConfig(userId);
  revalidatePath("/eos");
}
