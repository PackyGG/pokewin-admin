import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";

function safeTokenEqual(actual: string, expected: string): boolean {
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
    (method === "POST" && pathname === "/v1/rules") ||
    (method === "POST" && pathname === "/v1/fiat-email-domains") ||
    (method === "POST" && pathname === "/v1/risky-locations") ||
    (method === "PUT" && pathname.startsWith("/v1/fiat-email-domains/")) ||
    (method === "PUT" && pathname.startsWith("/v1/risky-locations/")) ||
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
    (method === "POST" && pathname === "/v1/network-cases") ||
    (method === "GET" &&
      pathname.startsWith("/v1/networks/") &&
      pathname.endsWith("/reveal"));
  return needsAdminToken
    ? safeTokenEqual(token, config.API_ADMIN_TOKEN)
    : safeTokenEqual(token, config.API_TOKEN) ||
      safeTokenEqual(token, config.API_ADMIN_TOKEN);
}
