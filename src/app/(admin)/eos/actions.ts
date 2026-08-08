"use server";

import { revalidatePath } from "next/cache";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  deleteEosUserConfig,
  eosUserRuleSchema,
  updateEosTestConfig,
  updateEosUserConfig,
} from "@/lib/antifraud/eos-test-config-api";
import { getBattleTestDevReadDrizzleDb } from "@/lib/battle-test-dev-db";
import { user } from "@/lib/db-schema/main/schema";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { escapeLikePattern } from "@/lib/utils/sql-like";

export async function setUserOnlyLoses(input: unknown) {
  const session = await requireEosTestAccess();
  const userOnlyLoses = z.boolean().parse(input);
  const saved = await updateEosTestConfig({
    userOnlyLoses,
    actor: session.username,
  });
  revalidatePath("/eos");
  return saved;
}

export async function searchEosDevUsers(input: unknown) {
  await requireEosTestAccess();
  const query = z.string().trim().min(2).max(100).parse(input);
  const db = getBattleTestDevReadDrizzleDb();
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
  enabled: z.boolean(),
});

export async function saveEosUserConfig(input: unknown) {
  const session = await requireEosTestAccess();
  const parsed = saveUserConfigSchema.parse(input);
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
