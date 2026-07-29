import { isIP } from "node:net";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Config } from "./config.js";
import {
  FiatEligibilityAccess,
  type FiatEligibilityEnvironment,
} from "./fiat-eligibility-auth.js";
import {
  FiatEligibilityService,
  FingerprintReuseError,
  type FiatEligibilityDecision,
} from "./fiat-eligibility.js";

export const FIAT_ELIGIBILITY_PATH = "/v1/fiat-eligibility/check";
const MAX_LOGGED_VALIDATION_ISSUES = 5;

export type FiatEligibilityResponse = Pick<
  FiatEligibilityDecision,
  "decisionId" | "allowed" | "timestamp"
>;

function publicDecision(
  decision: FiatEligibilityDecision,
): FiatEligibilityResponse {
  return {
    decisionId: decision.decisionId,
    allowed: decision.allowed,
    timestamp: decision.timestamp,
  };
}

export const fiatEligibilityRequestSchema = z.object({
  env: z.enum(["dev", "prod"]),
  createdAt: z.iso.datetime(),
  ipAddress: z.string().trim().refine(
    (value) => isIP(value) !== 0,
    "ipAddress must be a valid IPv4 or IPv6 address",
  ),
  fingerprint: z.string().trim().min(10).max(200),
  userID: z.string().trim().min(1).max(100),
}).strict();

function bearerToken(authorization: string | undefined): string {
  return authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function validationIssues(error: z.ZodError): Array<{
  code: string;
  path: string;
}> {
  return error.issues
    .slice(0, MAX_LOGGED_VALIDATION_ISSUES)
    .map((issue) => ({
      code: issue.code,
      path: issue.path.join(".") || "body",
    }));
}

function safeErrorDetails(error: unknown): {
  errorCode?: string;
  errorType: string;
} {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as Error & { code?: unknown }).code;
  return {
    errorType: error.name,
    ...(typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code)
      ? { errorCode: code }
      : {}),
  };
}

export function authenticateFiatEligibilityRequest(
  access: FiatEligibilityAccess,
  input: {
    authorization: string | undefined;
    sourceIp: string;
    environment?: FiatEligibilityEnvironment;
  },
):
  | { authorized: true; environment: FiatEligibilityEnvironment }
  | {
      authorized: false;
      status: 401 | 403;
      error:
        | "unauthorized"
        | "source_ip_not_allowed"
        | "environment_credential_mismatch";
    } {
  const authentication = access.authenticate(
    bearerToken(input.authorization),
    input.sourceIp,
  );
  if (!authentication.authorized) {
    return {
      authorized: false,
      status: authentication.error === "unauthorized" ? 401 : 403,
      error: authentication.error,
    };
  }
  if (
    input.environment
    && authentication.environment !== input.environment
  ) {
    return {
      authorized: false,
      status: 403,
      error: "environment_credential_mismatch",
    };
  }
  return authentication;
}

export async function registerFiatEligibilityRoutes(
  app: FastifyInstance,
  input: {
    config: Config;
    access: FiatEligibilityAccess;
    service: FiatEligibilityService;
  },
): Promise<void> {
  app.post(
    FIAT_ELIGIBILITY_PATH,
    {
      bodyLimit: 4 * 1024,
      config: {
        rateLimit: {
          max: input.config.FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.ip,
          onExceeded: (request) => {
            request.log.warn(
              {
                event: "fiat_eligibility.rate_limited",
                requestId: request.id,
                sourceAddressFamily: isIP(request.ip) || null,
                statusCode: 429,
              },
              "Fiat eligibility request rate limited",
            );
          },
        },
      },
    },
    async (request, reply) => {
      const startedAt = Date.now();
      const parsed = fiatEligibilityRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn(
          {
            event: "fiat_eligibility.invalid_request",
            requestId: request.id,
            statusCode: 400,
            durationMs: elapsedMs(startedAt),
            validationIssues: validationIssues(parsed.error),
          },
          "Fiat eligibility request rejected by validation",
        );
        return reply.code(400).send({
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid request",
        });
      }
      const authentication = authenticateFiatEligibilityRequest(input.access, {
        authorization: request.headers.authorization,
        sourceIp: request.ip,
        environment: parsed.data.env,
      });
      if (!authentication.authorized) {
        request.log.warn(
          {
            event: "fiat_eligibility.authentication_rejected",
            requestId: request.id,
            environment: parsed.data.env,
            reason: authentication.error,
            sourceAddressFamily: isIP(request.ip) || null,
            statusCode: authentication.status,
            durationMs: elapsedMs(startedAt),
          },
          "Fiat eligibility request rejected by authentication",
        );
        return reply
          .code(authentication.status)
          .send({ error: authentication.error });
      }
      request.log.info(
        {
          event: "fiat_eligibility.assessment_started",
          requestId: request.id,
          environment: authentication.environment,
          userId: parsed.data.userID,
          clientAddressFamily: isIP(parsed.data.ipAddress),
          requestAgeMs: Date.now() - new Date(parsed.data.createdAt).getTime(),
        },
        "Fiat eligibility assessment started",
      );
      try {
        const decision = await input.service.assess(parsed.data);
        request.log.info(
          {
            event: "fiat_eligibility.assessment_completed",
            requestId: request.id,
            environment: authentication.environment,
            userId: parsed.data.userID,
            decisionId: decision.decisionId,
            decision: decision.decision,
            allowed: decision.allowed,
            riskScore: decision.riskScore,
            reasonCodes: decision.reasonCodes,
            expiresAt: decision.expiresAt,
            idempotent: decision.idempotent,
            statusCode: 200,
            durationMs: elapsedMs(startedAt),
          },
          "Fiat eligibility assessment completed",
        );
        return publicDecision(decision);
      } catch (error) {
        if (error instanceof FingerprintReuseError) {
          request.log.warn(
            {
              event: "fiat_eligibility.fingerprint_reused",
              requestId: request.id,
              environment: authentication.environment,
              userId: parsed.data.userID,
              statusCode: 409,
              durationMs: elapsedMs(startedAt),
            },
            "Fiat eligibility request reused a Fingerprint event",
          );
          return reply.code(409).send({
            error: "fingerprint_reused",
            data: {
              decision: "deny",
              allowed: false,
              reasonCodes: ["fingerprint_reused"],
            },
          });
        }
        request.log.error(
          {
            event: "fiat_eligibility.assessment_failed",
            requestId: request.id,
            environment: authentication.environment,
            userId: parsed.data.userID,
            statusCode: 503,
            durationMs: elapsedMs(startedAt),
            ...safeErrorDetails(error),
          },
          "Automatic Fiat eligibility assessment failed",
        );
        return reply.code(503).send({
          error: "assessment_unavailable",
          data: {
            decision: "deny",
            allowed: false,
            reasonCodes: ["assessment_unavailable"],
          },
        });
      }
    },
  );
}
