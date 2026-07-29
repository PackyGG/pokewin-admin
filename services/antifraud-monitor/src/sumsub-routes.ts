import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  SumsubClient,
  SumsubRequestError,
} from "./sumsub-client.js";
import type {
  KycCountryReviewInput,
  KycCountryReviewService,
} from "./kyc-country-reviews.js";

const paramsSchema = z.object({
  applicantId: z.string().regex(/^[a-z0-9]{24}$/),
});

const countryChecksSchema = z.object({
  accounts: z
    .array(
      z.object({
        userId: z.string().trim().min(1).max(128),
        applicantId: z.string().regex(/^[a-z0-9]{24}$/),
        accountCountry: z.string().trim().min(2).max(3).nullable(),
      }),
    )
    .max(100),
});

export async function registerSumsubRoutes(
  app: FastifyInstance,
  client: SumsubClient | null,
  countryReviews?: Pick<KycCountryReviewService, "refresh">,
): Promise<void> {
  app.get("/v1/kyc/applicants/:applicantId/review", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { applicantId } = params.data;
    if (!client) {
      return reply.code(503).send({ error: "sumsub_not_configured" });
    }
    try {
      return { data: await client.getApplicantReview(applicantId) };
    } catch (error) {
      if (error instanceof SumsubRequestError) {
        request.log.warn(
          { providerStatus: error.status },
          "Sumsub applicant review read failed",
        );
        if (error.status === 404) {
          return reply.code(404).send({ error: "applicant_not_found" });
        }
        return reply.code(502).send({ error: "sumsub_unavailable" });
      }
      throw error;
    }
  });

  app.post("/v1/kyc/country-checks/refresh", async (request, reply) => {
    const parsed = countryChecksSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!client || !countryReviews) {
      return reply.code(503).send({ error: "sumsub_not_configured" });
    }
    const accounts: KycCountryReviewInput[] = parsed.data.accounts;
    return { data: await countryReviews.refresh(accounts) };
  });
}
