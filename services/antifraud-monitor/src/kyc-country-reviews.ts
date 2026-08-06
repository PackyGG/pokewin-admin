import countries from "i18n-iso-countries";
import type pg from "pg";

import {
  SumsubClient,
  SumsubRequestError,
  type SumsubApplicantReview,
} from "./sumsub-client.js";

export type KycCountryReviewInput = {
  userId: string;
  applicantId: string;
  accountCountry: string | null;
};

export type KycCountryReview = {
  userId: string;
  applicantId: string;
  accountCountry: string | null;
  verifiedCountry: string | null;
  documentCountries: string[];
  countryMatch: "match" | "mismatch" | "unknown";
  reviewStatus: string | null;
  reviewAnswer: string | null;
  providerReviewedAt: string | null;
  /**
   * When the row was last confirmed against the provider. `null` means the account was never
   * refreshed in this request and nothing is stored -- "not refreshed", never "clean".
   */
  checkedAt: string | null;
  /** True when the payload is not a fresh provider read (skipped by the cap, or a failure). */
  stale?: boolean;
  /** Why the payload is stale, when a provider call actually failed. */
  lastError?: string | null;
};

export type KycCountryReviewRefresh = {
  data: KycCountryReview[];
  /**
   * True when at least one requested account did not get a provider refresh because the
   * per-request cap was reached. The caller can retry the remainder instead of silently
   * treating a short list as the whole answer.
   */
  truncated: boolean;
};

type StoredRow = {
  user_id: string;
  applicant_id: string;
  account_country: string | null;
  verified_country: string | null;
  document_countries: string[];
  country_match: "match" | "mismatch" | "unknown";
  review_status: string | null;
  review_answer: string | null;
  provider_reviewed_at: Date | string | null;
  checked_at: Date | string;
};

const FRESH_FOR_MS = 6 * 60 * 60_000;
const MAX_PROVIDER_REFRESHES = 10;

function normalizeCountry(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  if (!code) return null;
  if (/^[A-Z]{2}$/.test(code)) return code;
  if (/^[A-Z]{3}$/.test(code)) return countries.alpha3ToAlpha2(code) ?? null;
  return null;
}

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 100) : null;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function fromRow(
  row: StoredRow,
  stale?: { lastError: string | null },
): KycCountryReview {
  return {
    userId: row.user_id,
    applicantId: row.applicant_id,
    accountCountry: row.account_country,
    verifiedCountry: row.verified_country,
    documentCountries: row.document_countries,
    countryMatch: row.country_match,
    reviewStatus: row.review_status,
    reviewAnswer: row.review_answer,
    providerReviewedAt: iso(row.provider_reviewed_at),
    checkedAt: iso(row.checked_at),
    ...(stale ? { stale: true, lastError: stale.lastError } : {}),
  };
}

/**
 * A row that was requested but never refreshed and has nothing stored. Returned instead of
 * being dropped so the caller can tell "we did not refresh this" apart from "this account has
 * no country evidence at all".
 */
function placeholder(
  input: KycCountryReviewInput,
  lastError: string | null,
): KycCountryReview {
  return {
    userId: input.userId,
    applicantId: input.applicantId,
    accountCountry: normalizeCountry(input.accountCountry),
    verifiedCountry: null,
    documentCountries: [],
    countryMatch: "unknown",
    reviewStatus: null,
    reviewAnswer: null,
    providerReviewedAt: null,
    checkedAt: null,
    stale: true,
    lastError,
  };
}

export function assessKycCountry(
  input: KycCountryReviewInput,
  review: SumsubApplicantReview,
  checkedAt = new Date(),
): KycCountryReview {
  const accountCountry = normalizeCountry(input.accountCountry);
  const documentCountries = [
    ...new Set(
      review.documents
        .filter((document) => document.reviewAnswer !== "RED")
        .map((document) => normalizeCountry(document.country))
        .filter((country): country is string => country !== null),
    ),
  ];
  const fallbackCountry =
    normalizeCountry(review.applicantCountry) ??
    normalizeCountry(review.declaredCountry);
  const comparisonCountries =
    documentCountries.length > 0
      ? documentCountries
      : fallbackCountry
        ? [fallbackCountry]
        : [];
  const verifiedCountry = comparisonCountries[0] ?? null;
  const countryMatch =
    !accountCountry || comparisonCountries.length === 0
      ? "unknown"
      : comparisonCountries.includes(accountCountry)
        ? "match"
        : "mismatch";

  return {
    userId: input.userId,
    applicantId: input.applicantId,
    accountCountry,
    verifiedCountry,
    documentCountries,
    countryMatch,
    reviewStatus: clean(review.reviewStatus),
    reviewAnswer: clean(review.reviewAnswer),
    providerReviewedAt: iso(review.reviewedAt),
    checkedAt: checkedAt.toISOString(),
  };
}

export class KycCountryReviewService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly sumsub: SumsubClient,
    private readonly now: () => Date = () => new Date(),
    private readonly onResultReady?: (
      review: KycCountryReview,
    ) => Promise<void>,
  ) {}

  async refresh(
    inputs: KycCountryReviewInput[],
  ): Promise<KycCountryReviewRefresh> {
    if (inputs.length === 0) return { data: [], truncated: false };
    const userIds = inputs.map((input) => input.userId);
    const applicantIds = inputs.map((input) => input.applicantId);
    const stored = await this.pool.query<StoredRow>(
      `SELECT user_id, applicant_id, account_country, verified_country,
              document_countries, country_match, review_status, review_answer,
              provider_reviewed_at, checked_at
         FROM kyc_country_reviews
        WHERE (user_id, applicant_id) IN (
          SELECT * FROM unnest($1::text[], $2::text[])
        )`,
      [userIds, applicantIds],
    );
    const saved = new Map(
      stored.rows.map((row) => [`${row.user_id}:${row.applicant_id}`, row]),
    );
    const now = this.now();
    const results: Array<KycCountryReview | null> = Array(inputs.length).fill(
      null,
    );
    let nextIndex = 0;
    let providerRefreshes = 0;
    let truncated = false;

    const refreshOne = async (
      input: KycCountryReviewInput,
    ): Promise<KycCountryReview> => {
      const key = `${input.userId}:${input.applicantId}`;
      const existing = saved.get(key);
      const existingCheckedAt = existing
        ? new Date(existing.checked_at).getTime()
        : 0;
      const normalizedAccountCountry = normalizeCountry(input.accountCountry);
      if (
        existing &&
        existingCheckedAt > now.getTime() - FRESH_FOR_MS &&
        existing.account_country === normalizedAccountCountry
      ) {
        return fromRow(existing);
      }
      if (providerRefreshes >= MAX_PROVIDER_REFRESHES) {
        truncated = true;
        // Never drop the row: a skipped account is "not refreshed", and stored data returned
        // past the cap must not read as a fresh confirmation either.
        return existing
          ? fromRow(existing, { lastError: null })
          : placeholder(input, null);
      }
      providerRefreshes += 1;

      try {
        const review = await this.sumsub.getApplicantReview(input.applicantId);
        const assessment = assessKycCountry(input, review, now);
        await this.pool.query(
          `INSERT INTO kyc_country_reviews (
             user_id, applicant_id, account_country, verified_country,
             document_countries, country_match, review_status, review_answer,
             provider_reviewed_at, checked_at
           ) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10)
           ON CONFLICT (user_id, applicant_id) DO UPDATE SET
             account_country = EXCLUDED.account_country,
             verified_country = EXCLUDED.verified_country,
             document_countries = EXCLUDED.document_countries,
             country_match = EXCLUDED.country_match,
             review_status = EXCLUDED.review_status,
             review_answer = EXCLUDED.review_answer,
             provider_reviewed_at = EXCLUDED.provider_reviewed_at,
             checked_at = EXCLUDED.checked_at,
             updated_at = now()`,
          [
            assessment.userId,
            assessment.applicantId,
            assessment.accountCountry,
            assessment.verifiedCountry,
            assessment.documentCountries,
            assessment.countryMatch,
            assessment.reviewStatus,
            assessment.reviewAnswer,
            assessment.providerReviewedAt,
            assessment.checkedAt,
          ],
        );
        if (
          assessment.providerReviewedAt &&
          assessment.providerReviewedAt !== iso(existing?.provider_reviewed_at ?? null)
        ) {
          await this.onResultReady?.(assessment);
        }
        return assessment;
      } catch (error) {
        // A provider failure must never read as clean. Log it with the applicant id and hand
        // the caller an explicitly stale payload rather than silently aged-out "fresh" data.
        const lastError = error instanceof SumsubRequestError
          ? `sumsub_${error.status}`
          : error instanceof Error
            ? error.message.slice(0, 200)
            : "unknown_error";
        console.error("[kyc-country-review] provider refresh failed", {
          applicantId: input.applicantId,
          providerStatus:
            error instanceof SumsubRequestError ? error.status : null,
          lastError,
          hasStoredEvidence: Boolean(existing),
        });
        return existing
          ? fromRow(existing, { lastError })
          : placeholder(input, lastError);
      }
    };

    const worker = async (): Promise<void> => {
      while (nextIndex < inputs.length) {
        const index = nextIndex++;
        results[index] = await refreshOne(inputs[index]!);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(5, inputs.length) },
        () => worker(),
      ),
    );

    return {
      data: results.filter(
        (review): review is KycCountryReview => review !== null,
      ),
      truncated,
    };
  }
}
