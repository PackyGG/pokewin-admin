import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";

export function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function serviceRequestAuthorized(
  method: string,
  pathname: string,
  token: string,
  config: Pick<Config, "API_TOKEN" | "API_ADMIN_TOKEN">,
): boolean {
  const needsAdminToken =
    // Live transport observability names admin actor ids per connection; the
    // read token must not see them.
    (method === "GET" && pathname === "/v1/operations/live") ||
    (method === "POST" && pathname === "/v1/rules") ||
    (method === "POST" && pathname === "/v1/fiat-email-domains") ||
    (method === "POST" && pathname === "/v1/risky-locations") ||
    (method === "POST" && pathname.startsWith("/v1/blocklists/")) ||
    (method === "PUT" && pathname.startsWith("/v1/fiat-email-domains/")) ||
    (method === "PUT" && pathname.startsWith("/v1/risky-locations/")) ||
    (method === "PUT" && pathname.startsWith("/v1/blocklists/")) ||
    (method === "PUT" && pathname.startsWith("/v1/rules/")) ||
    (method === "PUT" && pathname.startsWith("/v1/scoring/")) ||
    (method === "PUT" && pathname.startsWith("/v1/analysis-rules/")) ||
    (method === "POST" && pathname.includes("/decision")) ||
    (method === "POST" && pathname.includes("/rescan")) ||
    (method === "POST" &&
      pathname.startsWith("/v1/fiat-deposits/") &&
      pathname.endsWith("/review")) ||
    (method === "POST" &&
      pathname.startsWith("/v1/withdrawals/") &&
      pathname.endsWith("/review")) ||
    (method === "GET" &&
      pathname.startsWith("/v1/kyc/applicants/") &&
      pathname.endsWith("/review")) ||
    (pathname === "/v1/operations/signup-failures" && method === "GET") ||
    (method === "POST" &&
      pathname.startsWith("/v1/operations/signup-failures/")) ||
    (method === "POST" &&
      pathname === "/v1/kyc/country-checks/refresh") ||
    (method === "POST" && pathname === "/v1/network-cases") ||
    (method === "GET" &&
      pathname.startsWith("/v1/networks/") &&
      pathname.endsWith("/reveal"));
  return needsAdminToken
    ? safeTokenEqual(token, config.API_ADMIN_TOKEN)
    : safeTokenEqual(token, config.API_TOKEN) ||
      safeTokenEqual(token, config.API_ADMIN_TOKEN);
}
