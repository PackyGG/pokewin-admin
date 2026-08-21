"use server";

import { revalidatePath } from "next/cache";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  deleteEosUserConfig,
  eosUserRuleSchema,
  getEosTestConfig,
  listEosUserSelections,
  updateEosTestConfig,
  updateEosUserConfig,
  updateEosUserForceLosses,
} from "@/lib/antifraud/eos-test-config-api";
import { getBattleTestDevReadDrizzleDb } from "@/lib/battle-test-dev-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { user } from "@/lib/db-schema/main/schema";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { escapeLikePattern } from "@/lib/utils/sql-like";

const saveFlowSchema = z.object({
  rules: z.array(eosUserRuleSchema).min(1).max(20),
  persistent: z.boolean(),
  randomized: z.boolean(),
  enabled: z.boolean(),
  forceAllLosses: z.boolean(),
}).refine((flow) => !flow.randomized || flow.persistent);

export async function saveGlobalEosFlow(input: unknown) {
  const [session, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const flow = saveFlowSchema.parse(input);
  const saved = await updateEosTestConfig(environment, {
    ...flow,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function setEosUserForceLosses(input: unknown) {
  const [session, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const parsed = z.object({
    userId: z.string().trim().min(1).max(100),
    forceLosses: z.boolean(),
  }).strict().parse(input);
  const saved = await updateEosUserForceLosses(environment, {
    ...parsed,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function setGlobalForceAllLosses(input: unknown) {
  const [session, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const forceAllLosses = z.boolean().parse(input);
  const current = await getEosTestConfig(environment);
  const saved = await updateEosTestConfig(environment, {
    rules: current.rules,
    persistent: current.persistent,
    randomized: current.randomized,
    enabled: current.enabled,
    forceAllLosses,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function searchEosUsers(input: unknown) {
  const [, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const query = z.string().trim().min(2).max(100).parse(input);
  const db = environment === "prod"
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

export async function getEosUserSelections(input: unknown) {
  const [, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const userId = z.string().trim().min(1).max(100).parse(input);
  return listEosUserSelections(environment, userId, 20);
}

const saveUserConfigSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  username: z.string().trim().min(1).max(100).nullable(),
  rules: z.array(eosUserRuleSchema).min(1).max(20),
  persistent: z.boolean(),
  randomized: z.boolean(),
  enabled: z.boolean(),
  forceLosses: z.boolean(),
});

export async function saveEosUserConfig(input: unknown) {
  const [session, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const parsed = saveUserConfigSchema
    .refine((flow) => !flow.randomized || flow.persistent)
    .parse(input);
  const saved = await updateEosUserConfig(environment, {
    ...parsed,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function removeEosUserConfig(input: unknown) {
  const [, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const userId = z.string().trim().min(1).max(100).parse(input);
  await deleteEosUserConfig(environment, userId);
  revalidatePath("/eos");
}
