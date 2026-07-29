import "server-only";

import { z } from "zod";

const documentSchema = z.object({
  step: z.string(),
  country: z.string().nullable(),
  documentType: z.string().nullable(),
  reviewAnswer: z.string().nullable(),
});

const historySchema = z.object({
  attemptId: z.string().nullable(),
  levelName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewStatus: z.string().nullable(),
  reviewAnswer: z.string().nullable(),
  reviewRejectType: z.string().nullable(),
  rejectLabels: z.array(z.string()),
});

const reviewSchema = z.object({
  applicantCountry: z.string().nullable(),
  declaredCountry: z.string().nullable(),
  nationality: z.string().nullable(),
  countryOfBirth: z.string().nullable(),
  reviewStatus: z.string().nullable(),
  reviewAnswer: z.string().nullable(),
  reviewRejectType: z.string().nullable(),
  rejectLabels: z.array(z.string()),
  reviewedAt: z.string().nullable(),
  levelName: z.string().nullable(),
  attemptCount: z.number().int().nonnegative().nullable(),
  documents: z.array(documentSchema),
  history: z.array(historySchema),
  fetchedAt: z.string(),
});

const responseSchema = z.object({ data: reviewSchema });

export type SumsubApplicantReview = z.infer<typeof reviewSchema>;

export async function getSumsubApplicantReview(
  applicantId: string,
): Promise<SumsubApplicantReview | null> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) return null;

  try {
    const response = await fetch(
      `${baseUrl}/v1/kyc/applicants/${encodeURIComponent(applicantId)}/review`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) {
      console.error(
        `[antifraud-sumsub] review request failed with status ${response.status}`,
      );
      return null;
    }
    return responseSchema.parse(await response.json()).data;
  } catch (error) {
    console.error(
      "[antifraud-sumsub] review request failed:",
      error instanceof Error ? error.message : "unknown_error",
    );
    return null;
  }
}
