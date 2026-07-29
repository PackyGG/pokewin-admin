import { createHmac } from "node:crypto";

import { z } from "zod";

const reviewResultSchema = z
  .object({
    reviewAnswer: z.string().optional(),
    reviewRejectType: z.string().optional(),
    rejectLabels: z.array(z.string()).optional(),
  })
  .passthrough();

const personInfoSchema = z
  .object({
    country: z.string().optional(),
    nationality: z.string().optional(),
    countryOfBirth: z.string().optional(),
  })
  .passthrough();

const applicantSchema = z
  .object({
    info: personInfoSchema.optional(),
    fixedInfo: personInfoSchema.optional(),
    review: z
      .object({
        reviewStatus: z.string().optional(),
        reviewDate: z.string().optional(),
        levelName: z.string().optional(),
        attemptCnt: z.number().int().nonnegative().optional(),
        reviewResult: reviewResultSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const documentStepSchema = z
  .object({
    country: z.string().optional(),
    idDocType: z.string().optional(),
    reviewResult: reviewResultSchema.optional(),
  })
  .passthrough();

const documentStatusSchema = z.record(z.string(), documentStepSchema);

const reviewHistorySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            attemptId: z.string().optional(),
            levelName: z.string().optional(),
            reviewDate: z.string().optional(),
            reviewStatus: z.string().optional(),
            reviewResult: reviewResultSchema.optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type SumsubDocumentReview = {
  step: string;
  country: string | null;
  documentType: string | null;
  reviewAnswer: string | null;
};

export type SumsubReviewHistoryItem = {
  attemptId: string | null;
  levelName: string | null;
  reviewedAt: string | null;
  reviewStatus: string | null;
  reviewAnswer: string | null;
  reviewRejectType: string | null;
  rejectLabels: string[];
};

export type SumsubApplicantReview = {
  applicantCountry: string | null;
  declaredCountry: string | null;
  nationality: string | null;
  countryOfBirth: string | null;
  reviewStatus: string | null;
  reviewAnswer: string | null;
  reviewRejectType: string | null;
  rejectLabels: string[];
  reviewedAt: string | null;
  levelName: string | null;
  attemptCount: number | null;
  documents: SumsubDocumentReview[];
  history: SumsubReviewHistoryItem[];
  fetchedAt: string;
};

export class SumsubRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SumsubRequestError";
  }
}

type Fetch = typeof fetch;

type SumsubClientOptions = {
  token: string;
  secretKey: string;
  fetchImpl?: Fetch;
  now?: () => Date;
  cacheTtlMs?: number;
};

type CachedReview = {
  expiresAt: number;
  review: SumsubApplicantReview;
};

const SUMSUB_BASE_URL = "https://api.sumsub.com";
const CACHE_LIMIT = 500;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function labels(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((label) => label.trim()).filter(Boolean))]
    .slice(0, 25);
}

export class SumsubClient {
  private readonly fetchImpl: Fetch;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CachedReview>();

  constructor(private readonly options: SumsubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  }

  private async getJson(path: string): Promise<unknown> {
    const timestamp = String(Math.floor(this.now().getTime() / 1_000));
    const signature = createHmac("sha256", this.options.secretKey)
      .update(`${timestamp}GET${path}`)
      .digest("hex");
    const response = await this.fetchImpl(`${SUMSUB_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-app-token": this.options.token,
        "x-app-access-ts": timestamp,
        "x-app-access-sig": signature,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new SumsubRequestError(
        response.status,
        `Sumsub read failed with status ${response.status}`,
      );
    }
    return response.json();
  }

  async getApplicantReview(applicantId: string): Promise<SumsubApplicantReview> {
    const cached = this.cache.get(applicantId);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAt > nowMs) return cached.review;
    if (cached) this.cache.delete(applicantId);

    const encodedId = encodeURIComponent(applicantId);
    const [applicantPayload, documentPayload, historyPayload] = await Promise.all([
      this.getJson(`/resources/applicants/${encodedId}/one`),
      this.getJson(`/resources/applicants/${encodedId}/requiredIdDocsStatus`),
      this.getJson(`/resources/applicants/${encodedId}/review/history`),
    ]);
    const applicant = applicantSchema.parse(applicantPayload);
    const documentStatus = documentStatusSchema.parse(documentPayload);
    const history = reviewHistorySchema.parse(historyPayload);
    const reviewResult = applicant.review?.reviewResult;

    const review: SumsubApplicantReview = {
      applicantCountry: clean(applicant.info?.country),
      declaredCountry: clean(applicant.fixedInfo?.country),
      nationality: clean(applicant.info?.nationality),
      countryOfBirth: clean(applicant.info?.countryOfBirth),
      reviewStatus: clean(applicant.review?.reviewStatus),
      reviewAnswer: clean(reviewResult?.reviewAnswer),
      reviewRejectType: clean(reviewResult?.reviewRejectType),
      rejectLabels: labels(reviewResult?.rejectLabels),
      reviewedAt: clean(applicant.review?.reviewDate),
      levelName: clean(applicant.review?.levelName),
      attemptCount: applicant.review?.attemptCnt ?? null,
      documents: Object.entries(documentStatus)
        .map(([step, document]) => ({
          step,
          country: clean(document.country),
          documentType: clean(document.idDocType),
          reviewAnswer: clean(document.reviewResult?.reviewAnswer),
        }))
        .filter(
          (document) =>
            document.country ||
            document.documentType ||
            document.reviewAnswer,
        )
        .slice(0, 25),
      history: history.items.slice(0, 10).map((item) => ({
        attemptId: clean(item.attemptId),
        levelName: clean(item.levelName),
        reviewedAt: clean(item.reviewDate),
        reviewStatus: clean(item.reviewStatus),
        reviewAnswer: clean(item.reviewResult?.reviewAnswer),
        reviewRejectType: clean(item.reviewResult?.reviewRejectType),
        rejectLabels: labels(item.reviewResult?.rejectLabels),
      })),
      fetchedAt: this.now().toISOString(),
    };

    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(applicantId, {
      expiresAt: nowMs + this.cacheTtlMs,
      review,
    });
    return review;
  }
}
