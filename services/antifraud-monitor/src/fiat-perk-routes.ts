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
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
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
    const run = await service.startRun({
      scope: parsed.data.scope,
      minAccountAgeDays: parsed.data.minAccountAgeDays,
      limit: parsed.data.limit,
      countryCode: parsed.data.countryCode?.toUpperCase() ?? null,
      activeWithinDays: parsed.data.activeWithinDays,
      excludeGranted: parsed.data.excludeGranted,
      excludedUserIds: parsed.data.excludedUserIds,
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
    return {
      data: await service.listCandidates({
        runId: params.data.id,
        verdict: query.data.verdict,
        decision: query.data.decision,
        search: query.data.search,
        limit: query.data.limit,
      }),
    };
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
