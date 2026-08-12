import type pg from "pg";

import type { EnrichmentResult } from "./enrichment.js";
import type { SignupContext } from "./scoring.js";
import type { Signup } from "./types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = object(current)[key];
  return current;
}

function normalizedAsn(value: unknown): string | null {
  const candidate = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim().replace(/^AS/i, "")
      : null;
  return candidate && /^\d{1,10}$/.test(candidate) && candidate !== "0"
    ? candidate
    : null;
}

/** Extract an allowlisted ASN without depending on one provider being online. */
export function providerNetworkAsn(
  results: readonly EnrichmentResult[],
): string | null {
  for (const result of results) {
    const response = result.response;
    const candidates = result.provider === "fingerprint"
      ? [
          at(response, "products", "ipInfo", "data", "v4", "asn", "asn"),
          at(response, "products", "ipInfo", "data", "v6", "asn", "asn"),
        ]
      : result.provider === "abstract_ip"
        ? [at(response, "asn", "asn")]
        : result.provider === "proxycheck"
          ? [at(response, "result", "asn"), at(response, "result", "network", "asn")]
          : [];
    for (const candidate of candidates) {
      const asn = normalizedAsn(candidate);
      if (asn) return asn;
    }
  }
  return null;
}

export type SignupCampaignContext = Pick<
  SignupContext,
  "sameCountry2m" | "sameCountryNetwork2m" | "generatedSameCountry2m"
>;

/**
 * Persist provider network evidence, then correlate only a tight two-minute
 * country window. The query is Antifraud-owned and never writes MAIN.
 */
export async function signupCampaignContext(
  db: pg.Pool,
  signup: Signup,
  providerResults: readonly EnrichmentResult[],
): Promise<SignupCampaignContext> {
  const networkAsn = providerNetworkAsn(providerResults);
  await db.query(
    `
      UPDATE signup_identity_snapshots
      SET network_asn = COALESCE(network_asn, $2)
      WHERE user_id = $1
    `,
    [signup.id, networkAsn],
  );
  if (!signup.country_code) {
    return {
      sameCountry2m: 0,
      sameCountryNetwork2m: 0,
      generatedSameCountry2m: 0,
    };
  }
  const result = await db.query<{
    same_country_2m: string;
    same_country_network_2m: string;
    generated_same_country_2m: string;
  }>(
    `
      SELECT
        COUNT(*)::text AS same_country_2m,
        COUNT(*) FILTER (
          WHERE $3::text IS NOT NULL AND network_asn = $3
        )::text AS same_country_network_2m,
        COUNT(*) FILTER (WHERE generated_username)::text
          AS generated_same_country_2m
      FROM signup_identity_snapshots
      WHERE UPPER(country_code) = UPPER($1)
        AND source_created_at BETWEEN
          $2::timestamptz - interval '2 minutes'
          AND $2::timestamptz + interval '30 seconds'
    `,
    [signup.country_code, signup.created_at, networkAsn],
  );
  return {
    sameCountry2m: Number(result.rows[0]?.same_country_2m ?? 0),
    sameCountryNetwork2m: Number(
      result.rows[0]?.same_country_network_2m ?? 0,
    ),
    generatedSameCountry2m: Number(
      result.rows[0]?.generated_same_country_2m ?? 0,
    ),
  };
}
