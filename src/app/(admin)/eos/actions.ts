"use server";

import { revalidatePath } from "next/cache";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  deleteEosUserConfig,
  eosUserRuleSchema,
  getEosTestConfig,
  getEosTestOverview,
  listEosSelectionSummaries,
  listEosUserSelections,
  updateEosTestConfig,
  updateEosTestEnabled,
  updateEosUserConfig,
  updateEosUserEnabled,
  updateEosUserForceLosses,
} from "@/lib/antifraud/eos-test-config-api";
import { getBattleTestDevReadDrizzleDb } from "@/lib/battle-test-dev-db";
import { getProdReadDrizzleDb } from "@/lib/db";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { user } from "@/lib/db-schema/main/schema";
import { requireEosTestAccess } from "@/lib/eos-test-access";
import { eosPlayerIntelligenceInputSchema } from "@/lib/eos-player-intelligence-shared";
import { getEosPlayerIntelligence } from "@/lib/queries/eos-player-intelligence";
import {
  getEosObservedCreatorBattles,
  getRecentEosObservedBattles,
} from "@/lib/queries/eos-user-history";
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

export async function setGlobalEosEnabled(input: unknown) {
  const [session, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const enabled = z.boolean().parse(input);
  const saved = await updateEosTestEnabled(environment, {
    enabled,
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

export async function getEosUserBattleHistory(input: unknown) {
  const [, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const userId = z.string().trim().min(1).max(100).parse(input);
  const [observed, selections, summaries, overview] = await Promise.all([
    getEosObservedCreatorBattles(environment, userId, 30),
    listEosUserSelections(environment, userId, 50),
    listEosSelectionSummaries(environment, 50, userId),
    getEosTestOverview(environment),
  ]);
  const realSelections = selections.filter((entry) => entry.currency === "real");
  const decisionsByBattle = new Map(realSelections.map((entry) => [entry.battleId, entry]));
  const summariesByBattle = new Map(summaries.map((entry) => [entry.battleId, entry]));
  const observedIds = new Set(observed.map((entry) => entry.battleId));
  const trackingStartedAt = overview.trackingStartedAt;
  const entries = [
    ...observed.map((battle) => ({
      battleId: battle.battleId,
      occurredAt: battle.createdAt,
      observed: battle,
      decision: decisionsByBattle.get(battle.battleId) ?? null,
      selectionSummary: summariesByBattle.get(battle.battleId) ?? null,
      beforeTracking: trackingStartedAt !== null
        && new Date(battle.createdAt).getTime() < new Date(trackingStartedAt).getTime(),
    })),
    ...realSelections
      .filter((entry) => !observedIds.has(entry.battleId))
      .map((decision) => ({
        battleId: decision.battleId,
        occurredAt: decision.selectedAt,
        observed: null,
        decision,
        selectionSummary: summariesByBattle.get(decision.battleId) ?? null,
        beforeTracking: false,
      })),
  ].sort((left, right) =>
    new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()
  );

  return {
    environment,
    trackingStartedAt,
    entries,
    summary: {
      creatorBattles: observed.length,
      controlledBattles: entries.filter((entry) => entry.selectionSummary?.configured).length,
      auditedBattles: entries.filter((entry) => entry.decision !== null).length,
      legacyBattles: entries.filter((entry) =>
        entry.selectionSummary && !entry.selectionSummary.auditAvailable
      ).length,
      missingAudit: entries.filter((entry) =>
        entry.observed && !entry.decision && !entry.selectionSummary && !entry.beforeTracking
      ).length,
    },
  };
}

export async function loadEosPlayerIntelligence(input: unknown) {
  const [, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const filters = eosPlayerIntelligenceInputSchema.parse(input);
  return getEosPlayerIntelligence(environment, { ...filters, currency: "real" });
}

export async function loadEosBattles() {
  const [, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const [battles, selections] = await Promise.all([
    getRecentEosObservedBattles(environment, 50),
    listEosSelectionSummaries(environment, 50),
  ]);
  const selectionsByBattle = new Map(selections.map((entry) => [entry.battleId, entry]));
  return {
    environment,
    generatedAt: new Date().toISOString(),
    rows: battles.map((battle) => ({
      battle,
      selection: selectionsByBattle.get(battle.battleId) ?? null,
    })),
  };
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

export async function setEosUserEnabled(input: unknown) {
  const [session, environment] = await Promise.all([
    requireEosTestAccess(),
    readDbEnvFromCookie(),
  ]);
  const parsed = z.object({
    userId: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
  }).strict().parse(input);
  const saved = await updateEosUserEnabled(environment, {
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
