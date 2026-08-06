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

const countryReviewSchema = z.object({
  userId: z.string(),
  applicantId: z.string(),
  accountCountry: z.string().nullable(),
  verifiedCountry: z.string().nullable(),
  documentCountries: z.array(z.string()),
  countryMatch: z.enum(["match", "mismatch", "unknown"]),
  reviewStatus: z.string().nullable(),
  reviewAnswer: z.string().nullable(),
  providerReviewedAt: z.string().nullable(),
  // `null` means the monitor never refreshed this account in the request (the per-request
  // provider cap was hit) and has nothing stored — "not refreshed", never "clean".
  checkedAt: z.string().nullable(),
  stale: z.boolean().optional(),
  lastError: z.string().nullable().optional(),
});

const countryReviewResponseSchema = z.object({
  data: z.array(countryReviewSchema),
  // True when the monitor's per-request provider cap truncated the refresh.
  truncated: z.boolean().optional(),
});

export type KycCountryReview = z.infer<typeof countryReviewSchema>;

type KycCountryReviewInput = {
  userId: string;
  applicantId: string;
  accountCountry: string | null;
};

function monitorCredentials(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

export async function getSumsubApplicantReview(
  applicantId: string,
): Promise<SumsubApplicantReview | null> {
  const credentials = monitorCredentials();
  if (!credentials) return null;

  try {
    const response = await fetch(
      `${credentials.baseUrl}/v1/kyc/applicants/${encodeURIComponent(applicantId)}/review`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credentials.token}`,
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

export async function refreshKycCountryReviews(
  accounts: KycCountryReviewInput[],
): Promise<KycCountryReview[]> {
  const credentials = monitorCredentials();
  if (!credentials || accounts.length === 0) return [];

  try {
    const response = await fetch(
      `${credentials.baseUrl}/v1/kyc/country-checks/refresh`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accounts: accounts.slice(0, 100) }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      console.error(
        `[antifraud-sumsub] country review request failed with status ${response.status}`,
      );
      return [];
    }
    return countryReviewResponseSchema.parse(await response.json()).data;
  } catch (error) {
    console.error(
      "[antifraud-sumsub] country review request failed:",
      error instanceof Error ? error.message : "unknown_error",
    );
    return [];
  }
}
