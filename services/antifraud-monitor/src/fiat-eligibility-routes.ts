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
} from "./fiat-eligibility.js";

export const FIAT_ELIGIBILITY_PATH = "/v1/fiat-eligibility/check";

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
      config: {
        rateLimit: {
          max: input.config.FIAT_ELIGIBILITY_RATE_LIMIT_PER_MINUTE,
          timeWindow: "1 minute",
          keyGenerator: (request) => request.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = fiatEligibilityRequestSchema.safeParse(request.body);
      if (!parsed.success) {
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
        return reply
          .code(authentication.status)
          .send({ error: authentication.error });
      }
      try {
        const decision = await input.service.assess(parsed.data);
        return { data: decision };
      } catch (error) {
        if (error instanceof FingerprintReuseError) {
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
            err: error,
            environment: parsed.data.env,
            userId: parsed.data.userID,
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
