import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  FIAT_PERK_SCOPES,
  FiatPerkService,
  MAX_PERK_RUN_ACCOUNTS,
  PerkCandidateNotFoundError,
  PerkDecisionConflictError,
} from "./fiat-perks.js";
import {
  FiatPerkAccessService,
  PerkAccessSyncError,
} from "./fiat-perk-access.js";

const actorSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(200),
  actorUsername: z.string().trim().min(1).max(100).nullish(),
});

const runSchema = actorSchema.extend({
  scope: z.enum(FIAT_PERK_SCOPES),
  minAccountAgeDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(DEFAULT_MIN_ACCOUNT_AGE_DAYS),
  limit: z.coerce.number().int().min(1).max(MAX_PERK_RUN_ACCOUNTS).default(200),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .nullish(),
  activeWithinDays: z.coerce.number().int().min(1).max(365).default(30),
  excludeGranted: z.boolean().default(true),
  excludedUserIds: z.array(z.string().trim().min(1).max(100)).max(5_000)
    .default([]),
  selectedUserIds: z.array(z.string().trim().min(1).max(100)).max(500)
    .default([]),
});

const decisionSchema = actorSchema.extend({
  decision: z.enum(["approved", "declined"]),
  note: z.string().trim().min(1).max(500).nullish(),
});

const revokeSchema = actorSchema.extend({
  reason: z.string().trim().min(4).max(500),
});

const candidateQuerySchema = z.object({
  verdict: z.enum(["pass", "review", "fail"]).optional(),
  decision: z.enum(["pending", "approved", "declined"]).optional(),
  accessStatus: z.enum(["none", "unknown", "syncing", "enabled", "disabled", "error"]).optional(),
  countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
  minRiskScore: z.coerce.number().min(0).max(100).optional(),
  maxRiskScore: z.coerce.number().min(0).max(100).optional(),
  maxMindStatus: z.enum(["success", "failed", "skipped", "not_checked"]).optional(),
  minMaxMindRisk: z.coerce.number().min(0).max(100).optional(),
  maxMaxMindRisk: z.coerce.number().min(0).max(100).optional(),
  maxMindDisposition: z.enum(["accept", "reject", "manual_review", "test"]).optional(),
  providerName: z.enum([
    "fingerprint",
    "proxycheck",
    "abstract_ip",
    "abstract_email",
    "opportify",
    "maxmind",
  ]).optional(),
  providerStatus: z.enum(["success", "skipped", "failed", "missing"]).optional(),
  providerCompleteness: z.enum(["complete", "partial", "unknown"]).optional(),
  minProviderScore: z.coerce.number().min(0).max(100).optional(),
  maxProviderScore: z.coerce.number().min(0).max(100).optional(),
  providerSignal: z.string().trim().min(1).max(120).optional(),
  providerChecked: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  minAccountAgeDays: z.coerce.number().min(0).max(36500).optional(),
  maxAccountAgeDays: z.coerce.number().min(0).max(36500).optional(),
  blockingReason: z.string().trim().min(1).max(100).optional(),
  minCryptoDepositUsd: z.coerce.number().min(0).max(1_000_000_000).optional(),
  minFiatDepositUsd: z.coerce.number().min(0).max(1_000_000_000).optional(),
  minWagerUsd: z.coerce.number().min(0).max(1_000_000_000).optional(),
  maxRewardUsd: z.coerce.number().min(0).max(1_000_000_000).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const accessBatchSchema = actorSchema.extend({
  action: z.enum(["enable", "disable"]),
  candidateIds: z.array(z.string().uuid()).max(100).default([]),
  userIds: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  note: z.string().trim().min(4).max(500).nullish(),
  filterSnapshot: z.record(z.string(), z.unknown()).default({}),
});

const grantQuerySchema = z.object({
  status: z.enum(["granted", "revoked"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

function decisionErrorReply(error: unknown): {
  status: 404 | 409;
  body: { error: string; message: string };
} | null {
  if (error instanceof PerkCandidateNotFoundError) {
    return {
      status: 404,
      body: { error: "not_found", message: error.message },
    };
  }
  if (error instanceof PerkDecisionConflictError) {
    return {
      status: 409,
      body: { error: "decision_conflict", message: error.message },
    };
  }
  return null;
}

export async function registerFiatPerkRoutes(
  app: FastifyInstance,
  service: FiatPerkService,
  access: FiatPerkAccessService,
): Promise<void> {
  app.get("/v1/fiat-perks/runs", async (request) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .parse((request.query as { limit?: unknown } | null)?.limit ?? 20);
    return { data: await service.listRuns(limit) };
  });

  app.post("/v1/fiat-perks/runs", async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
    }
    if (parsed.data.scope === "country" && !parsed.data.countryCode) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "A country scope needs a country code.",
      });
    }
    if (
      parsed.data.scope === "selected_accounts"
      && parsed.data.selectedUserIds.length === 0
    ) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "A selected-account run needs at least one user id.",
      });
    }
    const run = await service.startRun({
      scope: parsed.data.scope,
      minAccountAgeDays: parsed.data.minAccountAgeDays,
      limit: parsed.data.limit,
      countryCode: parsed.data.countryCode?.toUpperCase() ?? null,
      activeWithinDays: parsed.data.activeWithinDays,
      excludeGranted: parsed.data.excludeGranted,
      excludedUserIds: parsed.data.excludedUserIds,
      selectedUserIds: parsed.data.selectedUserIds,
      idempotencyKey: parsed.data.idempotencyKey,
      actorId: parsed.data.actorId,
      actorUsername: parsed.data.actorUsername ?? null,
    });
    return reply.code(201).send({ data: run });
  });

  app.get("/v1/fiat-perks/runs/:id", async (request, reply) => {
    const params = z
      .object({ id: z.string().uuid() })
      .safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const run = await service.getRun(params.data.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return { data: run };
  });

  app.get("/v1/fiat-perks/runs/:id/candidates", async (request, reply) => {
    const params = z
      .object({ id: z.string().uuid() })
      .safeParse(request.params);
    const query = candidateQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const hasProviderDetailFilter = query.data.providerStatus !== undefined
      || query.data.providerCompleteness !== undefined
      || query.data.minProviderScore !== undefined
      || query.data.maxProviderScore !== undefined
      || query.data.providerSignal !== undefined;
    if (hasProviderDetailFilter && !query.data.providerName) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Choose a provider before filtering its evidence.",
      });
    }
    if (
      query.data.providerStatus === "missing"
      && (
        query.data.providerCompleteness !== undefined
        || query.data.minProviderScore !== undefined
        || query.data.maxProviderScore !== undefined
        || query.data.providerSignal !== undefined
      )
    ) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Missing provider evidence cannot have score or signal filters.",
      });
    }
    return {
      data: await service.listCandidates({
        runId: params.data.id,
        verdict: query.data.verdict,
        decision: query.data.decision,
        accessStatus: query.data.accessStatus,
        countryCode: query.data.countryCode?.toUpperCase(),
        minRiskScore: query.data.minRiskScore,
        maxRiskScore: query.data.maxRiskScore,
        maxMindStatus: query.data.maxMindStatus,
        minMaxMindRisk: query.data.minMaxMindRisk,
        maxMaxMindRisk: query.data.maxMaxMindRisk,
        maxMindDisposition: query.data.maxMindDisposition,
        providerName: query.data.providerName,
        providerStatus: query.data.providerStatus,
        providerCompleteness: query.data.providerCompleteness,
        minProviderScore: query.data.minProviderScore,
        maxProviderScore: query.data.maxProviderScore,
        providerSignal: query.data.providerSignal,
        providerChecked: query.data.providerChecked,
        minAccountAgeDays: query.data.minAccountAgeDays,
        maxAccountAgeDays: query.data.maxAccountAgeDays,
        blockingReason: query.data.blockingReason,
        minCryptoDepositUsd: query.data.minCryptoDepositUsd,
        minFiatDepositUsd: query.data.minFiatDepositUsd,
        minWagerUsd: query.data.minWagerUsd,
        maxRewardUsd: query.data.maxRewardUsd,
        search: query.data.search,
        limit: query.data.limit,
      }),
    };
  });

  app.get("/v1/fiat-perks/access-batches", async (request) => {
    const limit = z.coerce.number().int().min(1).max(100).default(20)
      .parse((request.query as { limit?: unknown } | null)?.limit ?? 20);
    return { data: await access.listBatches(limit) };
  });

  app.post("/v1/fiat-perks/access-batches", async (request, reply) => {
    const parsed = accessBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request",
      });
    }
    try {
      const batch = parsed.data.action === "enable"
        ? await access.queueEnable({
          candidateIds: parsed.data.candidateIds,
          userIds: parsed.data.userIds,
          note: parsed.data.note ?? null,
          filterSnapshot: parsed.data.filterSnapshot,
          idempotencyKey: parsed.data.idempotencyKey,
          actorId: parsed.data.actorId,
          actorUsername: parsed.data.actorUsername ?? null,
        })
        : await access.queueDisable({
          userIds: parsed.data.userIds,
          note: parsed.data.note ?? "Bulk Fiat access disable",
          filterSnapshot: parsed.data.filterSnapshot,
          idempotencyKey: parsed.data.idempotencyKey,
          actorId: parsed.data.actorId,
          actorUsername: parsed.data.actorUsername ?? null,
        });
      return reply.code(202).send({ data: batch });
    } catch (error) {
      if (error instanceof PerkAccessSyncError) {
        return reply.code(409).send({ error: "access_conflict", message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/fiat-perks/access-batches/:id/retry", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const actor = actorSchema.safeParse(request.body);
    if (!params.success || !actor.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      return reply.code(202).send({ data: await access.retryBatch(params.data.id) });
    } catch (error) {
      if (error instanceof PerkAccessSyncError) {
        return reply.code(409).send({ error: "access_conflict", message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/fiat-perks/candidates/:id/decision",
    async (request, reply) => {
      const params = z
        .object({ id: z.string().uuid() })
        .safeParse(request.params);
      const parsed = decisionSchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: parsed.success
            ? "Invalid candidate id"
            : parsed.error.issues[0]?.message ?? "Invalid request",
        });
      }
      try {
        const candidate = await service.decide({
          candidateId: params.data.id,
          decision: parsed.data.decision,
          note: parsed.data.note ?? null,
          idempotencyKey: parsed.data.idempotencyKey,
          actorId: parsed.data.actorId,
          actorUsername: parsed.data.actorUsername ?? null,
        });
        return { data: candidate };
      } catch (error) {
        const mapped = decisionErrorReply(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    },
  );

  app.get("/v1/fiat-perks/grants", async (request, reply) => {
    const query = grantQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    return {
      data: await service.listGrants({
        status: query.data.status,
        search: query.data.search,
        limit: query.data.limit,
      }),
    };
  });

  app.post("/v1/fiat-perks/grants/:userId/revoke", async (request, reply) => {
    const params = z
      .object({ userId: z.string().trim().min(1).max(100) })
      .safeParse(request.params);
    const parsed = revokeSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: parsed.success
          ? "Invalid user id"
          : parsed.error.issues[0]?.message ?? "Invalid request",
      });
    }
    try {
      const grant = await service.revokeGrant({
        userId: params.data.userId,
        reason: parsed.data.reason,
        idempotencyKey: parsed.data.idempotencyKey,
        actorId: parsed.data.actorId,
        actorUsername: parsed.data.actorUsername ?? null,
      });
      return { data: grant };
    } catch (error) {
      const mapped = decisionErrorReply(error);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw error;
    }
  });
}
