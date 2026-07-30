export const PROVIDER_CONTRACTS = {
  fingerprint: {
    model: "Fingerprint Pro Plus",
    version: "server-api-sdk-6.11.0",
    endpoint: "Fingerprint Server API getEvent",
    method: "SDK",
    requiredDatum: "fingerprint_request_id",
  },
  proxycheck: {
    model: "ProxyCheck v3 Pro",
    version: "24-June-2026",
    endpoint: "/v3/{ip}",
    method: "GET",
    requiredDatum: "signup_ip",
  },
  abstract_ip: {
    model: "Abstract IP Intelligence",
    version: "v1",
    endpoint: "ip-intelligence.abstractapi.com/v1",
    method: "GET",
    requiredDatum: "signup_ip",
  },
  abstract_email: {
    model: "Abstract Email Reputation",
    version: "v1",
    endpoint: "emailreputation.abstractapi.com/v1",
    method: "POST",
    requiredDatum: "email",
  },
  opportify: {
    model: "Opportify Full Fraud Check",
    version: "intel-v1-fraud-analyze",
    endpoint: "/intel/v1/fraud/analyze",
    method: "POST",
    requiredDatum: "email_or_signup_ip",
  },
} as const;

export type SignupProvider = keyof typeof PROVIDER_CONTRACTS;
export type ProviderCompleteness = "complete" | "partial" | "unknown";
export type ProviderFailureKind =
  | "timeout"
  | "rate_limited"
  | "authentication"
  | "invalid_response"
  | "upstream"
  | "missing_compatible_datum"
  | "unknown";

export function classifyProviderFailure(
  errorCode: string | undefined,
): ProviderFailureKind {
  const code = errorCode?.toLowerCase() ?? "";
  if (/missing_(request_id|ip|email|email_and_ip)/.test(code)) {
    return "missing_compatible_datum";
  }
  if (/timeout|abort/.test(code)) return "timeout";
  if (/429|rate/.test(code)) return "rate_limited";
  if (/401|403|auth|key/.test(code)) return "authentication";
  if (/parse|invalid|schema|response_too_large|syntax|unexpected|json/.test(code)) {
    return "invalid_response";
  }
  if (/5\d\d|upstream/.test(code)) return "upstream";
  return "unknown";
}
